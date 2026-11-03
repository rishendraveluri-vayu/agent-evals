"""A harness adapter with no harness: it plays back `spec.harness_options` so the library's
loop, timeout, crash handling and outputs can be tested without a model.

harness_options:
  turns: list of {stop, reply, model_calls, tools: [{name, args, result, is_error, kind}],
                  sleep_s, raise, echo_max_steps}
  crash_before_lib: exit code to exit with before the library starts
  spawn_orphan: start a child that outlives the adapter
"""

import subprocess
import sys
import time
from pathlib import Path

from evals_adapter import Adapter, TurnResult, main
from evals_adapter.spec import TrialPaths, load_spec


class Scripted(Adapter):
    name = "scripted"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def version(self):
        return "0.0.1"

    def setup(self, ctx):
        self.opts = ctx.spec["harness_options"]
        self.turn = 0
        ctx.applied.set("top_p", 1.0, "harness_default")
        cfg = ctx.paths.harness / "config.txt"
        cfg.write_text("frozen\n")
        ctx.integrity_paths.append(cfg)
        if self.opts.get("spawn_orphan"):
            subprocess.Popen(["sleep", "300"])  # noqa: S607

    def run_turn(self, ctx, history, max_steps):
        script = self.opts.get("turns", [])
        step = script[min(self.turn, len(script) - 1)]
        self.turn += 1
        if step.get("echo_max_steps"):
            ctx.harness_extra.setdefault("max_steps_seen", []).append(max_steps)
        for i, tool in enumerate(step.get("tools", [])):
            call_id = f"call_{self.turn}_{i}"
            ctx.tool_started(call_id, tool["name"], tool.get("args", {}))
            if tool.get("kind") == "malformed_tool_call":
                ctx.error_event("malformed_tool_call", "bad json")
            ctx.tool_finished(
                call_id,
                tool.get("result", "{}"),
                is_error=tool.get("is_error", False),
                error_kind=tool.get("kind"),
            )
        if step.get("sleep_s"):
            ctx.tool_started("call_sleep", "slow_tool", {})
            time.sleep(step["sleep_s"])
        if step.get("raise"):
            raise RuntimeError(step["raise"])
        if step.get("tamper"):
            (ctx.paths.harness / "config.txt").write_text("changed\n")
        reply = step.get("reply")
        if reply == "{{last_user}}":
            reply = "echo: " + history[-1]["content"]
        return TurnResult(
            stop=step.get("stop", "answered"),
            reply=reply,
            model_calls=step.get("model_calls", 1),
            input_tokens=step.get("input_tokens", 10),
            output_tokens=step.get("output_tokens", 5),
            harness_stop_reason=step.get("reason", "stop"),
        )


if __name__ == "__main__":
    spec = load_spec(TrialPaths.from_env().spec)
    code = spec["harness_options"].get("crash_before_lib")
    if code is not None:
        print("crashing on purpose", file=sys.stderr)
        sys.exit(code)
    main(Scripted())
