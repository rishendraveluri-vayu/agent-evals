"""Which adapter code ran a trial (D85, 7 Nov): a sha256 over the adapter's source files.

A config's hash covers `adapter_version`, the harness worker's pyproject version. That was never
bumped, so one config hash ran different adapter code (the Hermes adapter changed twice after the
5 Nov headline run). So the worker hashes the code itself, once at startup, sends the hash with
every claim, and the API stores it on the trial, outside the config hash.

What is hashed: the two packages the adapter process imports, the harness's own (`ownloop`,
`hermes_adapter`, ...) and this library (`evals_adapter`), found where the adapter's own
interpreter finds them (`adapter_packages`). In each, every `.py` file and `capabilities.json`,
named by its path from the package's parent (`hermes_adapter/adapter.py`); `__pycache__` is left
out and symlinks are not followed.

The hash is the sha256 of a `sha256sum`-style listing, one `<sha256 hex>  <path>` line per file,
sorted by path. It depends on file names and bytes only, never on where the packages are or when
the files were written, so the same source gives the same hash in an image and in a checkout:

    python -m evals_adapter.source_hash workers/hermes/src/hermes_adapter \\
        workers/adapterlib/src/evals_adapter

Standard library only, like the rest of the library (every harness environment imports it).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path

LIBRARY_PACKAGE = "evals_adapter"
SOURCE_SUFFIXES = (".py",)
SOURCE_NAMES = ("capabilities.json",)
SKIPPED_DIRS = ("__pycache__",)
FINDER_TIMEOUT_S = 60.0

# Run by the adapter's own interpreter: where each named package is, without importing it.
# find_spec of a top-level name only searches sys.path; it runs none of the package's code.
_FINDER = (
    "import importlib.util, json, sys\n"
    "found = {}\n"
    "for name in sys.argv[1:]:\n"
    "    spec = importlib.util.find_spec(name)\n"
    "    found[name] = list(spec.submodule_search_locations or []) if spec else []\n"
    "print(json.dumps(found))\n"
)


class SourceHashError(RuntimeError):
    """The adapter's packages could not be found or read, so no hash can be given."""


def _is_source(name: str) -> bool:
    return name.endswith(SOURCE_SUFFIXES) or name in SOURCE_NAMES


def source_files(package: Path) -> list[tuple[str, Path]]:
    """The package's source files as (path from the package's parent, path), sorted. Only
    regular files count; a symlink, to a file or a folder, is never followed."""
    package = Path(package)
    if not package.is_dir():
        raise SourceHashError(f"{package} is not a folder")
    found = []
    for dirpath, dirnames, filenames in os.walk(package, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIPPED_DIRS)
        rel = Path(dirpath).relative_to(package)
        for name in filenames:
            path = Path(dirpath) / name
            if _is_source(name) and stat.S_ISREG(os.lstat(path).st_mode):
                found.append(((Path(package.name) / rel / name).as_posix(), path))
    return sorted(found)


def source_listing(packages: Iterable[Path]) -> str:
    """`<sha256 hex>  <path>` per source file of every package, sorted by path, as `sha256sum`
    writes it. Two packages with the same name are refused: their paths would collide."""
    packages = [Path(p) for p in packages]
    names = [p.name for p in packages]
    if len(set(names)) != len(names):
        raise SourceHashError(f"two packages share a name: {names}")
    rows = []
    for package in packages:
        for rel, path in source_files(package):
            rows.append((rel, hashlib.sha256(path.read_bytes()).hexdigest()))
    if not rows:
        raise SourceHashError(f"no source files in {[str(p) for p in packages]}")
    return "".join(f"{digest}  {rel}\n" for rel, digest in sorted(rows))


def source_sha256(packages: Iterable[Path]) -> str:
    """`sha256:<hex>` of `source_listing(packages)`."""
    listing = source_listing(packages)
    return "sha256:" + hashlib.sha256(listing.encode("utf-8")).hexdigest()


def adapter_module(adapter_cmd: Sequence[str]) -> tuple[int, str] | None:
    """Where `-m <module>` is in the adapter command, and the module, or None without one."""
    for i in range(len(adapter_cmd) - 2, -1, -1):
        if adapter_cmd[i] == "-m" and adapter_cmd[i + 1]:
            return i, adapter_cmd[i + 1]
    return None


def adapter_packages(
    adapter_cmd: Sequence[str],
    env: Mapping[str, str] | None = None,
    cwd: Path | str | None = None,
    timeout_s: float = FINDER_TIMEOUT_S,
) -> list[Path]:
    """The harness package and `evals_adapter`, as the adapter's interpreter would import them.

    The adapter command must run a module (`... python -m <package>.adapter`, as every worker
    image's does). Everything before `-m` (an `env PYTHONPATH=...` prefix, the interpreter) is kept
    and `-m <module> ...` becomes a small `-c` script, so the search path is the one the adapter
    gets. Pass the environment and working folder the runner starts the adapter with."""
    found_m = adapter_module(adapter_cmd)
    if found_m is None:
        raise SourceHashError("the adapter command runs no module (no `-m <package>.<module>`)")
    i, module = found_m
    harness = module.split(".", 1)[0]
    names = list(dict.fromkeys([harness, LIBRARY_PACKAGE]))
    cmd = [*adapter_cmd[:i], "-c", _FINDER, *names]
    try:
        proc = subprocess.run(  # noqa: S603 - the worker's own adapter command
            cmd,
            capture_output=True,
            text=True,
            env=dict(env) if env is not None else None,
            cwd=str(cwd) if cwd is not None else None,
            stdin=subprocess.DEVNULL,
            timeout=timeout_s,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SourceHashError(f"could not ask the adapter's interpreter: {exc!r}") from exc
    if proc.returncode != 0:
        raise SourceHashError(
            f"the adapter's interpreter exited {proc.returncode}: {proc.stderr.strip()[-500:]}"
        )
    try:
        found = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise SourceHashError(f"unreadable answer from the interpreter: {proc.stdout!r}") from exc
    packages = []
    for name in names:
        locations = found.get(name) if isinstance(found, dict) else None
        if not isinstance(locations, list) or len(locations) != 1:
            raise SourceHashError(f"package {name} is at {locations!r}, not in one folder")
        packages.append(Path(locations[0]))
    return packages


def adapter_source_sha256(
    adapter_cmd: Sequence[str],
    env: Mapping[str, str] | None = None,
    cwd: Path | str | None = None,
) -> tuple[str, list[Path]]:
    """The adapter code's hash and the package folders it covers. Raises SourceHashError."""
    packages = adapter_packages(adapter_cmd, env=env, cwd=cwd)
    return source_sha256(packages), packages


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Print the adapter code hash (D85) of package folders, as a worker sends it."
    )
    parser.add_argument("packages", nargs="+", type=Path, help="package folders, e.g. src/ownloop")
    parser.add_argument("--list", action="store_true", help="print the hashed listing as well")
    args = parser.parse_args(argv)
    try:
        listing = source_listing(args.packages)
    except SourceHashError as exc:
        raise SystemExit(f"evals_adapter.source_hash: {exc}") from exc
    if args.list:
        sys.stdout.write(listing)
    print("sha256:" + hashlib.sha256(listing.encode("utf-8")).hexdigest())


if __name__ == "__main__":
    main()
