"""The adapter code hash (D85): stable, path- and mtime-blind, and changed by any source edit."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from support import REPO, SCRIPTED_CMD

from evals_adapter.source_hash import (
    SourceHashError,
    adapter_packages,
    adapter_source_sha256,
    source_listing,
    source_sha256,
)

LIBRARY = REPO / "workers" / "adapterlib" / "src" / "evals_adapter"


def make_package(root: Path, name: str = "fake_harness") -> Path:
    pkg = root / name
    (pkg / "sub").mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "adapter.py").write_text("print('adapter')\n")
    (pkg / "sub" / "__init__.py").write_text("X = 1\n")
    (pkg / "capabilities.json").write_text('{"harness": "fake"}\n')
    return pkg


def test_the_hash_is_sha256_of_a_sorted_sha256sum_listing(tmp_path):
    pkg = make_package(tmp_path)
    listing = source_listing([pkg])
    paths = [line.split("  ", 1)[1] for line in listing.splitlines()]
    assert paths == [
        "fake_harness/__init__.py",
        "fake_harness/adapter.py",
        "fake_harness/capabilities.json",
        "fake_harness/sub/__init__.py",
    ]
    first = listing.splitlines()[0].split("  ")[0]
    assert first == hashlib.sha256(b"").hexdigest()
    digest = source_sha256([pkg])
    assert digest == "sha256:" + hashlib.sha256(listing.encode()).hexdigest()
    assert len(digest) == len("sha256:") + 64
    # Stable: the same files give the same hash every time, whichever order the packages come in.
    lib = make_package(tmp_path, "evals_adapter")
    assert source_sha256([pkg, lib]) == source_sha256([lib, pkg]) == source_sha256([pkg, lib])


def test_the_hash_ignores_where_the_packages_are_and_when_they_were_written(tmp_path):
    pkg = make_package(tmp_path / "one")
    before = source_sha256([pkg])
    moved = tmp_path / "somewhere" / "else"
    shutil.copytree(pkg, moved / pkg.name)
    assert source_sha256([moved / pkg.name]) == before
    for path in pkg.rglob("*"):
        os.utime(path, (1_000_000_000, 1_000_000_000))
    assert source_sha256([pkg]) == before
    # Bytecode, other files and symlinks are not adapter source.
    (pkg / "__pycache__").mkdir()
    (pkg / "__pycache__" / "adapter.cpython-314.pyc").write_bytes(b"\x00compiled")
    (pkg / "README.md").write_text("notes\n")
    (pkg / "linked.py").symlink_to(pkg / "adapter.py")
    assert source_sha256([pkg]) == before


@pytest.mark.parametrize(
    "change",
    ["edit", "edit_capabilities", "add", "rename", "remove", "nested_edit"],
)
def test_any_change_to_a_source_file_changes_the_hash(tmp_path, change):
    pkg = make_package(tmp_path)
    before = source_sha256([pkg])
    if change == "edit":
        (pkg / "adapter.py").write_text("print('adapter, changed')\n")
    elif change == "edit_capabilities":
        (pkg / "capabilities.json").write_text('{"harness": "fake", "x": 1}\n')
    elif change == "add":
        (pkg / "extra.py").write_text("")
    elif change == "rename":
        (pkg / "adapter.py").rename(pkg / "adapter2.py")
    elif change == "remove":
        (pkg / "sub" / "__init__.py").unlink()
    else:
        (pkg / "sub" / "__init__.py").write_text("X = 2\n")
    assert source_sha256([pkg]) != before


def test_refuses_what_it_cannot_hash(tmp_path):
    with pytest.raises(SourceHashError, match="not a folder"):
        source_sha256([tmp_path / "missing"])
    (tmp_path / "empty").mkdir()
    with pytest.raises(SourceHashError, match="no source files"):
        source_sha256([tmp_path / "empty"])
    a, b = make_package(tmp_path / "a"), make_package(tmp_path / "b")
    with pytest.raises(SourceHashError, match="share a name"):
        source_sha256([a, b])


def test_the_command_line_prints_the_same_hash(tmp_path):
    pkg = make_package(tmp_path)
    out = subprocess.run(
        [sys.executable, "-m", "evals_adapter.source_hash", "--list", str(pkg), str(LIBRARY)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    assert out[-1] == source_sha256([pkg, LIBRARY])
    assert out[:-1] == source_listing([pkg, LIBRARY]).splitlines()


def test_the_adapters_own_interpreter_finds_the_packages(tmp_path):
    """As the Hermes image runs its adapter: `env PYTHONPATH=... python -m <pkg>.adapter`."""
    pkg = make_package(tmp_path / "src")
    cmd = ["env", f"PYTHONPATH={tmp_path / 'src'}", sys.executable, "-m", "fake_harness.adapter"]
    found = adapter_packages(cmd, env={"PATH": os.environ["PATH"]}, cwd=tmp_path)
    assert found == [pkg, LIBRARY]
    digest, packages = adapter_source_sha256([*cmd, "--some-arg"], cwd=tmp_path)
    assert packages == [pkg, LIBRARY]
    assert digest == source_sha256([pkg, LIBRARY])
    # Nothing of the package ran: find_spec only searches the path.
    (pkg / "__init__.py").write_text("raise SystemExit('imported')\n")
    assert adapter_packages(cmd, cwd=tmp_path) == [pkg, LIBRARY]


def test_no_hash_for_a_command_without_a_module_or_a_package_that_is_not_there(tmp_path):
    with pytest.raises(SourceHashError, match="runs no module"):
        adapter_packages(SCRIPTED_CMD)
    with pytest.raises(SourceHashError, match="not in one folder"):
        adapter_packages([sys.executable, "-m", "no_such_harness.adapter"], cwd=tmp_path)
    with pytest.raises(SourceHashError, match="could not ask"):
        adapter_packages([str(tmp_path / "no-python"), "-m", "x.adapter"])
    with pytest.raises(SourceHashError, match="exited 1"):
        adapter_packages(["false", "-m", "x.adapter"])
