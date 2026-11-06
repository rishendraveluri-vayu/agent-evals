"""Hermes Agent on the shared adapter library (contract v2), at the pinned SHA, unmodified.

Hermes is configured entirely from outside: a config.yaml and seeded files in a fresh
HERMES_HOME written before Hermes is imported, and constructor arguments. Every switch below
is there because the SP1 probes showed Hermes doing something a fair comparison cannot allow;
the evidence is in docs/hermes-notes.md and docs/research/hermes/sp1_probes.md.

Runs on Hermes's own Python 3.14 environment, with this package and the stdlib-only adapter
library on PYTHONPATH, so nothing is installed into Hermes's environment.
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
from typing import Any

from evals_adapter import Adapter, TrialContext, TurnResult, main

HERMES_SHA = "6112c2adb9e11f69734a29be9d2696f345ffa06a"
CANNED_LIMIT_REPLY = "I reached the iteration limit and couldn't generate a summary."
# agent/message_sanitization.py:_repair_tool_call_arguments, at the pinned SHA.
REPAIR_MARKERS = (
    "Repaired malformed tool_call arguments",
    "Repaired unescaped control chars in tool_call arguments",
    "Repaired control-char-laced tool_call arguments",
    "Unrepairable tool_call arguments",
    "Sanitized empty tool_call arguments",
    "Sanitized Python-None tool_call arguments",
)


def hermes_config(ctx: TrialContext, opts: dict[str, Any]) -> dict[str, Any]:
    """config.yaml for the trial. JSON is valid YAML, so it is written as JSON."""
    s = ctx.settings
    memory_on = bool(s["memory"] and s["memory"]["enabled"])
    compression_on = bool(s["compression"] and s["compression"]["enabled"])
    servers = {}
    for server in ctx.mcp_servers:
        servers[server.name] = {
            "command": server.command,
            "args": server.args,
            "timeout": server.tool_timeout_s,
            # Only the toolset's tools; no resource or prompt utility tools (sp1_probes s6).
            "tools": {"include": server.allowed_tools, "resources": False, "prompts": False},
        }
    cfg: dict[str, Any] = {
        "model": {
            "default": ctx.model_name,
            "provider": "custom",
            "base_url": ctx.base_url,
            # Pinned so Hermes does not probe the proxy for the context length (s3).
            "context_length": 128000,
            "ollama_num_ctx": 0,
        },
        # Hermes sends reasoning_effort: medium on a custom provider unless told the model has
        # no reasoning; LiteLLM then rejects the request (s2).
        "model_overrides": {"custom": {ctx.model_name: {"supports_reasoning": False}}},
        "timezone": "UTC",
        "agent": {
            "environment_probe": False,
            "coding_context": "off",
            # R10.11: one attempt per model call, no recovery ladder; LiteLLM retries (D16).
            "api_max_retries": 1,
            "auto_recovery_cycles": 0,
        },
        "memory": {
            "memory_enabled": memory_on,
            "user_profile_enabled": memory_on,
            "nudge_interval": 0,
            "provider": "",
        },
        "skills": {
            "creation_nudge_interval": 0,
            "auto_load": [],
            "external_dirs": [],
            "project_discovery": False,
            "inline_shell": False,
        },
        # R3: no background self-improvement in any config.
        "auxiliary": {
            "background_review": {"enabled": False},
            "title_generation": {"enabled": False},
        },
        "curator": {"enabled": False},
        "compression": {
            "enabled": compression_on,
            "micro_compact": False,
            "prepare_ahead": False,
            "idle_compact_after_seconds": 0,
        },
        "telemetry": {"shared_metrics": {"enabled": False, "send": False}},
        "security": {"allow_lazy_installs": False},
        # Tool Search would hide every MCP tool behind three meta-tools (s6).
        "tools": {"tool_search": {"enabled": "off"}},
        "mcp_servers": servers,
    }
    # D31: Hermes's own cache_control markers are off in every config, like every other harness;
    # the harness option turns them back on (Hermes's default, "5m").
    if not opts.get("prompt_cache_markers", False):
        cfg["prompt_caching"] = {"cache_ttl": "off"}
    # D33: Hermes's "Parallel tool calls" prompt section tells the model to batch tool calls, so
    # with parallel_tool_calls false it is turned off through Hermes's own switch. True or unset
    # keeps Hermes's default (on); every other section stays as shipped (D20).
    if s["parallel_tool_calls"] is False:
        cfg["agent"]["parallel_tool_call_guidance"] = False
    return cfg


def seed_home(ctx: TrialContext, home: Path) -> None:
    seed = ctx.spec["seed"]
    if seed["memory"]:
        (home / "memories").mkdir(parents=True, exist_ok=True)
        (home / "memories" / "MEMORY.md").write_text("\n§\n".join(seed["memory"]) + "\n")
    for skill in seed["skills"]:
        path = home / "skills" / skill["name"] / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"---\nname: {skill['name']}\ndescription: {json.dumps(skill['description'])}\n---\n\n"
            + skill["body"]
        )


MEMORY_TEXT_LIMIT = 2000


def memory_read_events(ctx: TrialContext, home: Path) -> None:
    """Contract v2's `evals.memory.read`: the entries Hermes reads into the system prompt when a
    session starts (MEMORY.md and USER.md in its home, as memory_tool_store loads them)."""
    for target, filename in (("memory", "MEMORY.md"), ("user", "USER.md")):
        path = home / "memories" / filename
        if not path.exists():
            continue
        entries = [e.strip() for e in path.read_text().split("\n§\n") if e.strip()]
        if entries:
            ctx.event(
                "evals.memory.read",
                {
                    "evals.memory.target": target,
                    "evals.memory.entries": len(entries),
                    "evals.memory.content": "\n§\n".join(entries)[:MEMORY_TEXT_LIMIT],
                },
            )


def memory_skill_events(ctx: TrialContext, name: str, args: Any, result: Any) -> None:
    """Contract v2's `evals.memory.write`, `evals.skill.load` and `evals.skill.write`, from
    Hermes's own memory, skill_view and skill_manage tool calls. A call that failed changed
    nothing and loaded nothing, so it gets no event (its tool span still shows the error)."""
    if name not in ("memory", "skill_view", "skill_manage") or is_error_result(result):
        return
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return
    if not isinstance(args, dict):
        return
    if name == "memory":
        ops = args.get("operations")
        # Hermes still accepts the single-operation shape at the top level (memory_tool.py).
        for op in ops if isinstance(ops, list) else [args]:
            if not isinstance(op, dict):
                continue
            text = op.get("content") or op.get("new_text") or op.get("old_text") or ""
            ctx.event(
                "evals.memory.write",
                {
                    "evals.memory.target": str(args.get("target") or "memory"),
                    "evals.memory.action": str(op.get("action") or ""),
                    "evals.memory.content": str(text)[:MEMORY_TEXT_LIMIT],
                },
            )
    elif name == "skill_view":
        attrs = {"evals.skill.name": str(args.get("name") or "")}
        if args.get("file_path"):
            attrs["evals.skill.file"] = str(args["file_path"])
        ctx.event("evals.skill.load", attrs)
    else:
        ctx.event(
            "evals.skill.write",
            {
                "evals.skill.name": str(args.get("name") or ""),
                "evals.skill.action": str(args.get("action") or ""),
            },
        )


def is_error_result(result: Any) -> bool:
    """Whether a tool result Hermes handed back is an error: a JSON object with `error` and no
    `result`, or text starting "Error". Hermes appends its own notes after the JSON when a tool
    keeps failing ('{"error": ...}\\n\\n[Tool loop warning: ...]', seen in the positive control),
    so the JSON at the head of the text decides, not the whole text."""
    if isinstance(result, str):
        text = result.lstrip()
        try:
            result = json.loads(text)
        except ValueError:
            try:
                result, _ = json.JSONDecoder().raw_decode(text)
            except ValueError:
                return text.startswith("Error")
    return isinstance(result, dict) and "error" in result and "result" not in result


class Hermes(Adapter):
    name = "hermes"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def version(self) -> str:
        return HERMES_SHA[:12]

    def setup(self, ctx: TrialContext) -> None:
        opts = ctx.spec["harness_options"]
        home = ctx.paths.harness / "hermes"
        home.mkdir(parents=True, exist_ok=True)
        cfg = hermes_config(ctx, opts)
        (home / "config.yaml").write_text(json.dumps(cfg, indent=2) + "\n")
        seed_home(ctx, home)
        # Must be set before the import: importing run_agent builds the home (hermes-notes).
        os.environ["HERMES_HOME"] = str(home)
        os.environ["HERMES_TIMEZONE"] = "UTC"
        os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
        os.environ["TERMINAL_CWD"] = str(ctx.paths.home)
        os.environ.pop("HERMES_INTERACTIVE", None)
        ctx.integrity_paths += [
            home / "config.yaml",
            home / "SOUL.md",
            ctx.paths.home / "AGENTS.md",
        ]

        from run_agent import AIAgent  # noqa: PLC0415 - must follow HERMES_HOME
        from tools.mcp_tool_discovery import discover_mcp_tools  # noqa: PLC0415

        found = discover_mcp_tools()
        ctx.harness_extra["mcp_tools_registered"] = sorted(found or [])

        s = ctx.settings
        overrides: dict[str, Any] = {}
        if s["temperature"] is not None:
            overrides["temperature"] = s["temperature"]
        if s["max_output_tokens"] is not None:
            overrides["max_tokens"] = s["max_output_tokens"]
        if s["parallel_tool_calls"] is not None:
            overrides["parallel_tool_calls"] = s["parallel_tool_calls"]
        toolsets = [server.name for server in ctx.mcp_servers]
        memory_on = bool(s["memory"] and s["memory"]["enabled"])
        skills_on = bool(s["skills"] and s["skills"]["enabled"])
        if memory_on:
            toolsets.append("memory")
        if skills_on:
            toolsets.append("skills")
        toolsets += list(ctx.spec["tools"]["enabled_builtins"])

        self.agent = AIAgent(
            base_url=ctx.base_url,
            api_key=ctx.model_api_key,
            provider="custom",
            api_mode="chat_completions",  # never the Responses API, whatever the model name
            model=ctx.model_name,
            max_iterations=s["max_steps"] or 10_000,
            request_overrides=overrides,
            enabled_toolsets=toolsets,
            disabled_toolsets=[],
            skip_memory=True,  # external memory providers only; built-in memory follows config
            skip_background_review=True,
            skip_context_files=True,
            load_soul_identity=False,
            session_db=None,
            save_trajectories=False,
            checkpoints_enabled=False,
            pass_session_id=False,
            memory_manager=None,
            quiet_mode=True,
            tool_start_callback=lambda call_id, name, args: ctx.tool_started(call_id, name, args),
            tool_complete_callback=lambda call_id, name, args, result: (
                ctx.tool_finished(
                    call_id,
                    result,
                    is_error=is_error_result(result),
                    error_kind="tool_error" if is_error_result(result) else None,
                ),
                memory_skill_events(ctx, name, args, result),
            ),
            event_callback=lambda *a, **k: ctx.event(
                "evals.compression", {"evals.hermes.event": str(a[0]) if a else str(k)}
            ),
        )
        self.messages: list[dict[str, Any]] | None = None
        self._log_offset = 0
        self.memory_on = memory_on
        tool_names = [t.get("function", {}).get("name") for t in self.agent.tools or []]
        ctx.harness_extra["tool_names"] = tool_names
        ctx.harness_extra["prompt_cache_markers"] = bool(
            getattr(self.agent, "_use_prompt_caching", False)
        )
        ctx.applied.set(
            "prompt_cache_markers",
            ctx.harness_extra["prompt_cache_markers"],
            "platform_default" if "prompt_cache_markers" not in opts else "config",
            observed="D31: off unless the harness option turns it on (prompt_caching.cache_ttl "
            "off); when on, Hermes adds cache_control markers for claude models on a host "
            "named litellm",
        )
        # D33: what Hermes's own flag ended up as, read back from the agent.
        guidance = bool(getattr(self.agent, "_parallel_tool_call_guidance", True))
        ptc_source = ctx.spec["settings_sources"]["parallel_tool_calls"]
        if s["parallel_tool_calls"] is False:
            note = "D33: the 'Parallel tool calls' prompt section off (parallel_tool_calls false)"
        elif s["parallel_tool_calls"] is True:
            note = "D33: section kept as shipped (parallel_tool_calls true)"
        else:
            note = "D33: section kept as shipped (parallel_tool_calls unset)"
            ptc_source = "harness_default"
        ctx.applied.set(
            "parallel_tool_call_guidance",
            guidance,
            ptc_source,
            observed=note + "; config agent.parallel_tool_call_guidance",
        )
        ctx.applied.set("api_max_retries", 1, "platform_default", observed="R10.11: one attempt")
        ctx.applied.set("reasoning_effort", None, "platform_default", observed="kept off the wire")

    def run_turn(
        self, ctx: TrialContext, history: list[dict[str, str]], max_steps: int | None
    ) -> TurnResult:
        if max_steps is not None:
            self.agent.max_iterations = max_steps  # Hermes resets its budget from this per turn
        if self.messages is None:
            if self.memory_on:
                memory_read_events(ctx, ctx.paths.harness / "hermes")
            earlier = [{"role": m["role"], "content": m["content"]} for m in history[:-1]]
        else:
            earlier = self.messages
        result = self.agent.run_conversation(
            history[-1]["content"],
            system_message=ctx.system_prompt,
            conversation_history=earlier or None,
            task_id=ctx.spec["trial"]["id"],
        )
        if isinstance(result.get("messages"), list):
            self.messages = result["messages"]
        self._note_malformed(ctx, result.get("messages") or [], len(earlier))
        usage = {
            "model_calls": result.get("api_calls"),
            "input_tokens": result.get("input_tokens"),
            "output_tokens": result.get("output_tokens"),
            "cost_usd": result.get("estimated_cost_usd")
            if result.get("cost_status") == "ok"
            else None,
        }
        reason = result.get("turn_exit_reason") or result.get("failure_reason")
        reply = result.get("final_response")
        if result.get("failed") or result.get("interrupted"):
            # Hermes writes a user-facing apology into final_response; never pass it on.
            return TurnResult(
                stop="harness_error",
                reply=None,
                harness_stop_reason=reason,
                exception=RuntimeError(str(result.get("error") or reason)),
                **usage,
            )
        if str(reason or "").startswith("max_iterations_reached"):
            reply = None if (reply or "").strip() == CANNED_LIMIT_REPLY else reply
            return TurnResult(stop="step_limit", reply=reply, harness_stop_reason=reason, **usage)
        if not result.get("completed"):
            return TurnResult(
                stop="harness_error",
                reply=None,
                harness_stop_reason=reason or "not completed",
                **usage,
            )
        return TurnResult(stop="answered", reply=reply or "", harness_stop_reason=reason, **usage)

    def _note_malformed(
        self, ctx: TrialContext, messages: list[dict[str, Any]], start: int
    ) -> None:
        """D18 detection. Hermes repairs malformed tool-call JSON itself and runs the repaired
        call, or runs it with {} when it cannot repair it; the model is never told. No switch
        exists, so the behaviour is kept and counted (known_differences). Every repair is
        logged at WARNING by agent.message_sanitization, which is read here per turn. Any
        still-invalid arguments left in the transcript are counted too."""
        log = ctx.paths.harness / "hermes" / "logs" / "agent.log"
        if log.exists():
            with open(log, encoding="utf-8", errors="replace") as fh:
                fh.seek(self._log_offset)
                new = fh.read()
                self._log_offset = fh.tell()
            for line in new.splitlines():
                if "agent.message_sanitization" in line and any(m in line for m in REPAIR_MARKERS):
                    ctx.error_event("malformed_tool_call", "repaired by Hermes: " + line[-400:])
        for msg in messages[start:]:
            for call in msg.get("tool_calls") or []:
                raw = (call.get("function") or {}).get("arguments") or ""
                try:
                    json.loads(raw) if raw.strip() else None
                except ValueError:
                    name = call.get("function", {}).get("name")
                    ctx.error_event("malformed_tool_call", f"{name}: {raw[:300]}")

    def collect(self, ctx: TrialContext) -> None:
        home = ctx.paths.harness / "hermes"
        prompt = getattr(self.agent, "_cached_system_prompt", None)
        if prompt:
            ctx.write_artifact("hermes-system-prompt.txt", prompt)
        if self.messages is not None:
            ctx.write_artifact(
                "hermes-messages.json", json.dumps(self.messages, indent=1, default=str)
            )
        ctx.add_artifact(home / "config.yaml", "hermes-config.yaml")
        ctx.add_artifact(home / "logs", "hermes-logs")
        sessions = home / "sessions"
        if sessions.exists():
            for dump in sorted(sessions.glob("request_dump_*.json")):
                ctx.add_artifact(dump, f"hermes-sessions/{dump.name}")

    def teardown(self, ctx: TrialContext) -> None:
        with contextlib.suppress(Exception):
            self.agent.close()


def entry() -> None:
    main(Hermes())


if __name__ == "__main__":
    entry()
