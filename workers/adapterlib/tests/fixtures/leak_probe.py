"""A harness adapter with no model that probes D3 isolation between two trials.

harness_options:
  phase: "write" (trial 1) leaves a marker in every place named in `places` and starts processes
         that outlive it; "check" (trial 2) records what it can still see.
  places: names from PLACES to try. The host test uses only places inside the trial folder; the
          image test adds the container's other paths.
  escape: also start a process in its own session with an empty environment, which only the
          container sweep can find (the host sweep finds processes by their environment).

Both phases write what they saw to out/artifacts/leak-view.json, which the worker stores.
"""

import json
import os
import subprocess
from pathlib import Path

from evals_adapter import Adapter, TurnResult, main
from evals_adapter.spec import TrialPaths

MARKER = "leak-marker-from-trial-1"
SLEEPS = ("300", "301", "302")


def places(paths: TrialPaths) -> dict[str, Path]:
    return {
        "trial_root": paths.root / "leak.txt",
        "home": Path(os.environ["HOME"]) / "leak.txt",
        "tmp": Path(os.environ["TMPDIR"]) / "leak.txt",
        "harness": paths.harness / "leak.txt",
        "state": paths.state / "leak.txt",
        "artifacts": paths.artifacts / "leak.txt",
        "cwd": Path.cwd() / "leak-cwd.txt",
        "dev_shm": Path("/dev/shm/leak.txt"),
        "slash_tmp": Path("/tmp/leak.txt"),
        "var_tmp": Path("/var/tmp/leak.txt"),
        "opt": Path("/opt/leak.txt"),
        "root": Path("/leak.txt"),
        "runs": Path("/runs/leak.txt"),
    }


def sleepers() -> list[dict]:
    """Every live `sleep 30x` process this one can see."""
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            argv = Path(f"/proc/{entry}/cmdline").read_bytes().split(b"\0")
            state = Path(f"/proc/{entry}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        is_sleep = len(argv) >= 2 and argv[0].endswith(b"sleep")
        if state != "Z" and is_sleep and argv[1].decode() in SLEEPS:
            found.append({"pid": int(entry), "arg": argv[1].decode()})
    return found


def token_readers() -> dict:
    """Where this process can read the worker token from another process's environment."""
    seen = []
    readable_environs = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) == os.getpid():
            continue
        try:
            env = Path(f"/proc/{entry}/environ").read_bytes()
        except OSError:
            continue
        readable_environs += 1
        if b"EVALS_WORKER_TOKEN=" in env:
            seen.append(int(entry))
    try:
        Path("/proc/1/environ").read_bytes()
        pid1 = True
    except OSError:
        pid1 = False
    return {"pids_with_token": seen, "pid1_environ_readable": pid1, "readable": readable_environs}


def listing(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))


def runs_view() -> dict:
    root = Path("/runs")
    if not root.is_dir():
        return {"exists": False}
    try:
        files = [p for p in root.rglob("*") if p.is_file()]
    except OSError as exc:
        return {"exists": True, "error": repr(exc)}
    markers = []
    for p in files:
        try:
            if MARKER in p.read_text(errors="replace"):
                markers.append(str(p))
        except OSError:
            pass
    return {"exists": True, "files": len(files), "markers": markers}


def mount_points() -> list[str]:
    """Every mount point this process can see (/proc/self/mounts), to show what is shared."""
    try:
        lines = Path("/proc/self/mounts").read_text().splitlines()
    except OSError:
        return []
    return sorted({line.split()[1] for line in lines if len(line.split()) > 1})


class LeakProbe(Adapter):
    name = "leak-probe"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def setup(self, ctx):
        self.opts = ctx.spec["harness_options"]

    def run_turn(self, ctx, history, max_steps):
        opts = self.opts
        wanted = {k: v for k, v in places(ctx.paths).items() if k in opts.get("places", [])}
        view = {"phase": opts["phase"], "pid": os.getpid()}
        if opts["phase"] == "write":
            wrote = {}
            for name, path in wanted.items():
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(MARKER)
                    wrote[name] = "written"
                except OSError as exc:
                    wrote[name] = f"{type(exc).__name__}: {exc.strerror}"
            view["wrote"] = wrote
            kids = [
                subprocess.Popen(["sleep", "300"]),  # noqa: S607 - same group and session
                subprocess.Popen(["sleep", "301"], start_new_session=True),  # noqa: S607
            ]
            if opts.get("escape"):
                # Own session, no environment: neither its group, session nor tag ties it to
                # the trial any more.
                kids.append(
                    subprocess.Popen(  # noqa: S603
                        ["/bin/sleep", "302"], start_new_session=True, env={}
                    )
                )
            view["spawned"] = [k.pid for k in kids]
        else:
            seen = {}
            for name, path in wanted.items():
                try:
                    seen[name] = path.read_text() if path.exists() else None
                except OSError as exc:
                    seen[name] = f"{type(exc).__name__}: {exc.strerror}"
            view["seen"] = seen
            view["home"] = sorted(os.listdir(os.environ["HOME"]))
            view["tmp"] = sorted(os.listdir(os.environ["TMPDIR"]))
            view["trial_listing"] = listing(ctx.paths.root)
            view["dev_shm"] = sorted(os.listdir("/dev/shm")) if "dev_shm" in wanted else None
            view["sleepers"] = sleepers()
            view["token"] = token_readers()
            view["runs"] = runs_view() if "runs" in wanted else None
            view["mounts"] = mount_points()
        (ctx.paths.artifacts / "leak-view.json").write_text(json.dumps(view, indent=1))
        return TurnResult(stop="answered", reply=f"{opts['phase']} done", model_calls=0)


if __name__ == "__main__":
    main(LeakProbe())
