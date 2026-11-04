"""The adapter side of contract v2: everything a harness adapter does not have to write.

A harness adapter subclasses `Adapter` and writes two methods:

- `setup(ctx)`: map the spec's settings onto the harness (`apply_settings` in the contract),
  recording what it applied through `ctx.applied`;
- `run_turn(ctx, history, max_steps)`: run one agent turn and return a `TurnResult`, reporting
  tool calls and errors through the context's span helpers.

`run(adapter)` does the rest: read and check the spec, start the whole-trial timeout, open the
root span, run the conversation (one turn, or several with the simulated client), map the end
state, hash the files the harness may edit, and write result.json atomically.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from evals_adapter.sim import ClientSimulator, SimulatorError
from evals_adapter.spec import (
    CONTRACT_VERSION,
    END_STATES,
    SETTING_NAMES,
    McpServer,
    SpecError,
    TrialPaths,
    load_spec,
    mcp_servers,
)
from evals_adapter.trace import KIND_INTERNAL, Span, Tracer

TURN_STOPS = ("answered", "step_limit", "token_limit", "agent_error", "harness_error")
CAPABILITIES_ENV = "EVALS_CAPABILITIES_PATH"
EXIT_OK = 0
EXIT_SPEC = 2
EXIT_INTERNAL = 3


def utc_iso(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, tz=_dt.UTC).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str | None:
    if not path.exists():
        return None
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def log(message: str) -> None:
    print(f"[evals-adapter] {message}", file=sys.stderr, flush=True)


@dataclass
class TurnResult:
    """How one agent turn ended, in the harness's own terms mapped to ours.

    `stop` is one of answered, step_limit, token_limit, agent_error, harness_error. `reply` is the
    visible reply, or None. Never put a harness-written apology here: a failed run has no reply.
    Usage fields are the harness's own view; None means unknown, never zero.
    """

    stop: str
    reply: str | None
    model_calls: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    harness_stop_reason: str | None = None
    exception: BaseException | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class AppliedSettings:
    """Every setting with its value and source (R11): config, platform_default, harness_default
    or unsupported."""

    def __init__(self) -> None:
        self.values: dict[str, dict[str, Any]] = {}

    def set(self, name: str, value: Any, source: str, observed: str | None = None) -> None:
        entry: dict[str, Any] = {"value": value, "source": source}
        if observed:
            entry["observed"] = observed
        self.values[name] = entry

    def as_dict(self) -> dict[str, dict[str, Any]]:
        return dict(self.values)


class Counts:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.model_calls = 0
        self.tool_calls = 0
        self.tool_errors = 0
        self.malformed_tool_calls = 0

    def add(self, name: str, n: int = 1) -> None:
        with self._lock:
            setattr(self, name, getattr(self, name) + n)

    def as_dict(self) -> dict[str, int]:
        with self._lock:
            return {
                "model_calls": self.model_calls,
                "tool_calls": self.tool_calls,
                "tool_errors": self.tool_errors,
                "malformed_tool_calls": self.malformed_tool_calls,
            }


class TrialContext:
    """What an adapter sees: the spec, the trial paths, span helpers and recorders."""

    def __init__(
        self, spec: dict[str, Any], paths: TrialPaths, tracer: Tracer, caps: dict[str, Any]
    ) -> None:
        self.spec = spec
        self.paths = paths
        self.tracer = tracer
        self.capabilities = caps
        self.settings: dict[str, Any] = spec["settings"]
        self.applied = AppliedSettings()
        self.counts = Counts()
        self.harness_extra: dict[str, Any] = {}
        self.artifacts: list[str] = []
        self.integrity_paths: list[Path] = []
        self.root_span: Span | None = None
        self.turn_span: Span | None = None
        self._tool_spans: dict[str, Span] = {}
        self._lock = threading.Lock()

    # ---- spec helpers
    @property
    def system_prompt(self) -> str:
        return self.spec["system_prompt"]["text"]

    @property
    def model_name(self) -> str:
        return self.spec["model"]["name"]

    @property
    def base_url(self) -> str:
        return self.spec["model"]["base_url"]

    @property
    def model_api_key(self) -> str:
        name = self.spec["model"]["api_key_env"]
        key = os.environ.get(name)
        if not key:
            raise SpecError(f"model key variable {name} is not set")
        return key

    @property
    def mcp_servers(self) -> list[McpServer]:
        return mcp_servers(self.spec)

    def child_env(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        """A minimal environment for child processes such as the MCP server. It leaves out the
        model and simulator keys, so a tool process can never call a model (contract section 3)."""
        env = {
            k: v
            for k in ("PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "TZ")
            if (v := os.environ.get(k)) is not None
        }
        env.update(extra or {})
        return env

    # ---- span helpers
    def _parent(self) -> Span | None:
        return self.turn_span or self.root_span

    def tool_started(self, call_id: str | None, name: str, arguments: Any) -> Span:
        args = arguments if isinstance(arguments, str) else json.dumps(arguments, sort_keys=True)
        span = self.tracer.start(
            f"execute_tool {name}",
            parent=self._parent(),
            kind=KIND_INTERNAL,
            attrs={
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": name,
                "gen_ai.tool.call.id": call_id,
                "evals.tool.arguments": args,
            },
        )
        self.counts.add("tool_calls")
        with self._lock:
            self._tool_spans[call_id or f"anon-{span.span_id}"] = span
        return span

    def tool_finished(
        self,
        call_id: str | None,
        result: Any = None,
        is_error: bool = False,
        error_kind: str | None = None,
        span: Span | None = None,
    ) -> None:
        with self._lock:
            if span is None and call_id is not None:
                span = self._tool_spans.pop(call_id, None)
            elif span is not None:
                for k, v in list(self._tool_spans.items()):
                    if v is span:
                        self._tool_spans.pop(k)
        if span is None:
            return
        text = result if isinstance(result, str) or result is None else json.dumps(result)
        span.set_attrs({"evals.tool.is_error": is_error, "evals.tool.result": text})
        if is_error:
            self.counts.add("tool_errors")
            span.set_attrs({"evals.error.kind": error_kind or "tool_error"})
            span.end(ok=False, message=(text or error_kind or "tool error")[:500])
        else:
            span.end(ok=True)

    def event(self, name: str, attrs: dict[str, Any] | None = None) -> None:
        """A span event on the current turn (or the root): memory, skills, compression."""
        target = self._parent()
        if target is not None:
            target.event(name, attrs)

    def error_event(self, kind: str, message: str) -> None:
        """D18: malformed_tool_call, unknown_tool and the like. Counted and kept on the turn."""
        if kind == "malformed_tool_call":
            self.counts.add("malformed_tool_calls")
        self.event("evals.error", {"evals.error.kind": kind, "evals.error.message": message[:2000]})

    def add_artifact(self, src: Path, name: str | None = None) -> str | None:
        """Copy a harness file into out/artifacts and list it in the result."""
        if not src.exists():
            return None
        dest = self.paths.artifacts / (name or src.name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dest)
        rel = str(dest.relative_to(self.paths.out))
        with self._lock:
            if rel not in self.artifacts:
                self.artifacts.append(rel)
        return rel

    def write_artifact(self, name: str, data: str | bytes) -> str:
        dest = self.paths.artifacts / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            dest.write_text(data, encoding="utf-8")
        else:
            dest.write_bytes(data)
        rel = str(dest.relative_to(self.paths.out))
        with self._lock:
            if rel not in self.artifacts:
                self.artifacts.append(rel)
        return rel


class Adapter:
    """Base class for a harness adapter. Subclasses set `name` and `capabilities_path` and
    implement `setup` and `run_turn`."""

    name: str = "unnamed"
    capabilities_path: Path | None = None

    def version(self) -> str:
        return "unknown"

    def load_capabilities(self) -> dict[str, Any]:
        # The probe command points this at a temporary file that marks every probed setting
        # supported, so it can see what the adapter really sends. Never set in a real trial.
        path = os.environ.get(CAPABILITIES_ENV) or self.capabilities_path
        if path is None or not Path(path).exists():
            raise SpecError(f"{self.name}: capabilities.json not found at {path}")
        caps = json.loads(Path(path).read_text(encoding="utf-8"))
        if caps.get("contract_version") != CONTRACT_VERSION:
            raise SpecError(
                f"{self.name}: capabilities speak contract {caps.get('contract_version')}"
            )
        return caps

    def setup(self, ctx: TrialContext) -> None:  # apply_settings
        raise NotImplementedError

    def run_turn(
        self, ctx: TrialContext, history: list[dict[str, str]], max_steps: int | None
    ) -> TurnResult:
        raise NotImplementedError

    def collect(self, ctx: TrialContext) -> None:
        """Optional: copy harness files worth keeping into artifacts before the result."""

    def teardown(self, ctx: TrialContext) -> None:
        """Optional: close sessions and servers. Best effort; the runner sweeps leftovers."""


# --------------------------------------------------------------------------- running a trial


class _Trial:
    def __init__(self, adapter: Adapter, paths: TrialPaths) -> None:
        self.adapter = adapter
        self.paths = paths
        self.started = time.time()
        self.finish_lock = threading.Lock()
        self.finished = False
        self.ctx: TrialContext | None = None
        self.spec: dict[str, Any] | None = None
        self.transcript: list[dict[str, str]] = []
        self.final_answer: str | None = None
        self.agent_turns = 0
        self.client_turns = 0
        self.ended_by: str | None = None
        self.turns: list[TurnResult] = []
        self.integrity_before: dict[str, str | None] = {}

    # ---- result
    def _usage(self) -> dict[str, Any]:
        def total(attr: str) -> Any:
            values = [getattr(t, attr) for t in self.turns]
            if not values or any(v is None for v in values):
                return None
            return sum(values)

        return {
            "model_calls": total("model_calls"),
            "input_tokens": total("input_tokens"),
            "output_tokens": total("output_tokens"),
            "cost_usd": total("cost_usd"),
        }

    def finish(
        self,
        end_state: str,
        stop_reason: str | None = None,
        exc: BaseException | None = None,
        from_watchdog: bool = False,
    ) -> bool:
        """Write result.json exactly once. Returns False if another thread already did."""
        with self.finish_lock:
            if self.finished:
                return False
            self.finished = True
        assert end_state in END_STATES, end_state
        ctx = self.ctx
        spec = self.spec or {}
        ended = time.time()
        if ctx is not None:
            if from_watchdog:
                ctx.tracer.close_open(f"trial timeout after {spec['settings']['timeout_s']} s")
            if ctx.root_span is not None and not ctx.root_span.ended:
                ctx.root_span.set_attrs(
                    {"evals.end_state": end_state, "evals.harness_stop_reason": stop_reason}
                )
                ctx.root_span.end(ok=end_state == "answered", message=end_state)
            ctx.tracer.close()
        integrity_after = {}
        if ctx is not None:
            integrity_after = {p.name: sha256_file(p) for p in ctx.integrity_paths}
        last = self.final_answer
        result = {
            "contract_version": CONTRACT_VERSION,
            "trial_id": spec.get("trial", {}).get("id", "unknown"),
            "end_state": end_state,
            "end_detail": {
                "harness_stop_reason": stop_reason,
                "exception_type": type(exc).__name__ if exc else None,
                "exception_message": str(exc)[:4000] if exc else None,
                "last_message_excerpt": last[-2000:] if last else None,
            },
            "final_answer": self.final_answer,
            "conversation": {
                "agent_turns": self.agent_turns,
                "client_turns": self.client_turns,
                "ended_by": self.ended_by,
                "transcript": self.transcript,
            },
            "harness": {
                "name": self.adapter.name,
                "version": self.adapter.version(),
                "extra": ctx.harness_extra if ctx else {},
            },
            "applied_settings": ctx.applied.as_dict() if ctx else {},
            "harness_usage": self._usage(),
            "counts": ctx.counts.as_dict()
            if ctx
            else {"model_calls": 0, "tool_calls": 0, "tool_errors": 0, "malformed_tool_calls": 0},
            "integrity": {"before": self.integrity_before, "after": integrity_after},
            "timing": {
                "started_at": utc_iso(self.started),
                "ended_at": utc_iso(ended),
                "wall_s": round(ended - self.started, 3),
            },
            "artifacts": sorted(ctx.artifacts) if ctx else [],
        }
        if ctx is not None:
            usage = self._usage()
            if usage["model_calls"] is not None:
                result["counts"]["model_calls"] = usage["model_calls"]
        self.paths.out.mkdir(parents=True, exist_ok=True)
        tmp = self.paths.result.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.paths.result)
        return True

    # ---- watchdog
    def start_watchdog(self, timeout_s: float) -> None:
        deadline = self.started + timeout_s

        def watch() -> None:
            while True:
                left = deadline - time.time()
                if left <= 0:
                    break
                time.sleep(min(left, 0.5))
                if self.finished:
                    return
            try:
                if self.finish("timeout", stop_reason="adapter_timeout", from_watchdog=True):
                    log(f"timeout after {timeout_s} s: result written, exiting")
                    sys.stderr.flush()
                    os._exit(EXIT_OK)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                os._exit(EXIT_INTERNAL)

        threading.Thread(target=watch, name="evals-timeout", daemon=True).start()

    # ---- settings
    def prefill_applied(self, ctx: TrialContext) -> None:
        caps = ctx.capabilities.get("settings", {})
        for name in SETTING_NAMES:
            cap = caps.get(name, {})
            value = ctx.settings.get(name)
            source = ctx.spec["settings_sources"][name]
            if not cap.get("supported", False):
                if value is not None:
                    raise SpecError(f"setting {name} is not supported by {self.adapter.name}")
                observed = cap.get("observed") or (
                    f"harness default: {cap['default']!r}" if "default" in cap else None
                )
                ctx.applied.set(name, None, "unsupported", observed)
            else:
                ctx.applied.set(name, value, source if value is not None else "harness_default")

    # ---- conversation
    def run_conversation(self, ctx: TrialContext) -> tuple[str, str | None, BaseException | None]:
        spec = ctx.spec
        sim_spec = spec["task"]["client_sim"]
        history = [{"role": m["role"], "content": m["content"]} for m in spec["task"]["messages"]]
        self.transcript = [dict(m, source="task") for m in history]
        max_steps = ctx.settings.get("max_steps")
        used = 0
        sim = None
        if sim_spec is not None:
            key_env = sim_spec["model"]["api_key_env"]
            sim_key = os.environ.get(key_env)
            if not sim_key:
                raise SpecError(f"simulator key variable {key_env} is not set")
            sim = ClientSimulator(spec, sim_key, ctx.paths.sim_cache, ctx.paths.sim_replies)

        while True:
            remaining = None if max_steps is None else max_steps - used
            if remaining is not None and remaining <= 0:
                if sim is not None:
                    self.ended_by = "agent_end_state"
                return "step_limit", "max_steps reached before the next turn", None
            turn_index = self.agent_turns
            ctx.turn_span = ctx.tracer.start(
                "agent.turn", parent=ctx.root_span, attrs={"evals.turn.index": turn_index}
            )
            try:
                turn = self.adapter.run_turn(ctx, history, remaining)
            except Exception as exc:  # noqa: BLE001
                log("run_turn raised:\n" + traceback.format_exc())
                turn = TurnResult(
                    stop="harness_error",
                    reply=None,
                    exception=exc,
                    harness_stop_reason="adapter_exception",
                )
            if turn.stop not in TURN_STOPS:
                turn = TurnResult(
                    stop="harness_error",
                    reply=turn.reply,
                    harness_stop_reason=f"adapter returned unknown stop {turn.stop!r}",
                )
            self.turns.append(turn)
            self.agent_turns += 1
            used += turn.model_calls or 0
            ctx.turn_span.set_attrs(
                {
                    "evals.turn.stop": turn.stop,
                    "evals.turn.model_calls": turn.model_calls,
                    "evals.harness_stop_reason": turn.harness_stop_reason,
                }
            )
            ctx.turn_span.end(ok=turn.stop == "answered", message=turn.stop)
            ctx.turn_span = None
            if turn.reply is not None:
                history.append({"role": "assistant", "content": turn.reply})
                self.transcript.append(
                    {"role": "assistant", "content": turn.reply, "source": "agent"}
                )
                self.final_answer = turn.reply
            if turn.stop != "answered":
                if sim is not None:
                    self.ended_by = "agent_end_state"
                return turn.stop, turn.harness_stop_reason, turn.exception
            if sim is None:
                return "answered", turn.harness_stop_reason, None
            if self.client_turns >= sim_spec["max_client_turns"]:
                self.ended_by = "turn_cap"
                return "answered", turn.harness_stop_reason, None

            visible = [{"role": t["role"], "content": t["content"]} for t in self.transcript]
            sim_span = ctx.tracer.start(
                "client_sim.turn",
                parent=ctx.root_span,
                attrs={
                    "evals.sim.model": sim_spec["model"]["name"],
                    "evals.sim.index": self.client_turns,
                },
            )
            try:
                reply = sim.next(visible, client_has_spoken=self.client_turns > 0)
            except SimulatorError as exc:
                # D26: the simulator failed (its call, or a reply with no text), not the agent
                # and not the client: the runner labels the trial infra:sim_error.
                message = str(exc)
                sim_span.set_attrs(
                    {"evals.sim.cache_hit": exc.cache_hit, "evals.sim.cache_key": exc.key}
                )
                sim_span.event(
                    "evals.error",
                    {"evals.error.kind": exc.kind, "evals.error.message": message[:2000]},
                )
                sim_span.end(ok=False, message=message[:500])
                self.ended_by = "sim_error"
                return "harness_error", "simulator_error", exc
            sim_span.set_attrs(
                {
                    "evals.sim.cache_hit": reply.cache_hit,
                    "evals.sim.cache_key": reply.key,
                    "evals.sim.message": reply.message,
                    "evals.sim.done": reply.done,
                }
            )
            sim_span.end(ok=True)
            if reply.message is not None:
                self.client_turns += 1
                self.transcript.append(
                    {"role": "user", "content": reply.message, "source": "client_sim"}
                )
            # A reply with no message is the end marker alone after the client's own goodbye;
            # any other empty reply raised SimulatorError above.
            if reply.done:
                self.ended_by = "client"
                return "answered", turn.harness_stop_reason, None
            history.append({"role": "user", "content": reply.message})


def run(adapter: Adapter, paths: TrialPaths | None = None) -> int:
    """Run one trial in this process and return the exit code (contract section 7)."""
    paths = paths or TrialPaths.from_env()
    trial = _Trial(adapter, paths)
    try:
        spec = load_spec(paths.spec)
    except SpecError as exc:
        log(f"spec error: {exc}")
        return EXIT_SPEC
    trial.spec = spec
    trial.start_watchdog(float(spec["settings"]["timeout_s"]))
    paths.out.mkdir(parents=True, exist_ok=True)
    paths.artifacts.mkdir(parents=True, exist_ok=True)
    tracer = Tracer(paths.trace, spec["trial"]["id"])
    end_state, stop_reason, error = "harness_error", None, None
    try:
        caps = adapter.load_capabilities()
        ctx = TrialContext(spec, paths, tracer, caps)
        trial.ctx = ctx
        ctx.root_span = tracer.start(
            f"invoke_agent {adapter.name}",
            attrs={
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.agent.name": adapter.name,
                "gen_ai.request.model": spec["model"]["name"],
                "evals.trial.id": spec["trial"]["id"],
                "evals.trial.attempt": spec["trial"].get("attempt"),
                "evals.config.hash": spec["trial"].get("config_hash"),
                "evals.task.id": spec["trial"]["task_id"],
                "evals.system_prompt.version": spec["system_prompt"].get("version"),
                "evals.toolset.version": spec["tools"]["toolset"].get("version"),
                "evals.harness.version": adapter.version(),
            },
        )
        if spec["model"]["api_format"] not in caps.get("model_api_formats", []):
            raise SpecError(f"{adapter.name} does not speak {spec['model']['api_format']}")
        trial.prefill_applied(ctx)
        adapter.setup(ctx)
        trial.integrity_before = {p.name: sha256_file(p) for p in ctx.integrity_paths}
        end_state, stop_reason, error = trial.run_conversation(ctx)
        try:
            adapter.collect(ctx)
        except Exception:  # noqa: BLE001
            log("collect failed:\n" + traceback.format_exc())
    except Exception as exc:  # noqa: BLE001
        log("adapter failed:\n" + traceback.format_exc())
        end_state, stop_reason, error = "harness_error", "adapter_exception", exc
    try:
        trial.finish(end_state, stop_reason, error)
    except Exception:  # noqa: BLE001
        log("could not write result.json:\n" + traceback.format_exc())
        return EXIT_INTERNAL
    if trial.ctx is not None:
        done = threading.Event()

        def _teardown() -> None:
            try:
                adapter.teardown(trial.ctx)  # type: ignore[arg-type]
            except Exception:  # noqa: BLE001
                log("teardown failed:\n" + traceback.format_exc())
            finally:
                done.set()

        threading.Thread(target=_teardown, name="evals-teardown", daemon=True).start()
        done.wait(5.0)
    return EXIT_OK


def main(adapter: Adapter) -> None:
    """Entry point for an adapter script. Exits hard, so harness threads cannot hang the trial."""
    code = run(adapter)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
