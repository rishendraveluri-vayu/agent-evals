"""The openai-agents harness on the shared adapter library (contract v2, docs/adapter-contract.md).

Write two methods. The library does the rest: the spec, the whole-trial timeout, the spans, the
conversation loop with the simulated client, end states and the result.

Rules that matter here (R10): models only through ctx.base_url with ctx.model_api_key; no
retries in the harness (LiteLLM retries); only the task's tools (ctx.mcp_servers); nothing
learns unless the config says so; report, never judge.
"""

from __future__ import annotations

from pathlib import Path

from evals_adapter import Adapter, TrialContext, TurnResult, main

# Set to True once setup and run_turn work; the gate tests skip until then.
IMPLEMENTED = False


class OpenaiAgentsAdapter(Adapter):
    name = "openai-agents"
    capabilities_path = Path(__file__).with_name("capabilities.json")

    def version(self) -> str:
        return "TODO: the harness package version"

    def setup(self, ctx: TrialContext) -> None:
        """Map ctx.settings onto the harness (apply_settings) and start its MCP client.

        - ctx.settings: temperature, max_output_tokens, max_steps, timeout_s, parallel_tool_calls,
          memory, skills, compression (None where capabilities.json says unsupported).
        - ctx.mcp_servers: name, command, args, allowed_tools, tool_timeout_s. Start them with
          ctx.child_env(), which leaves the model key out.
        - ctx.applied.set(name, value, "harness_default", observed=...) for anything the harness
          decides on its own, so the UI shows it.
        - ctx.integrity_paths: files the harness can edit with no switch to stop it.
        """
        raise NotImplementedError

    def run_turn(
        self, ctx: TrialContext, history: list[dict[str, str]], max_steps: int | None
    ) -> TurnResult:
        """Run one agent turn on history[-1] (the new user message) using the harness's own
        session for earlier turns, within max_steps model calls.

        Report each tool call with ctx.tool_started(call_id, name, args) and
        ctx.tool_finished(call_id, result, is_error=..., error_kind=...), and D18 cases with
        ctx.error_event("malformed_tool_call" | "unknown_tool", message).
        Return TurnResult(stop="answered" | "step_limit" | "token_limit" | "agent_error" |
        "harness_error", reply=..., model_calls=..., input_tokens=..., output_tokens=...).
        """
        raise NotImplementedError


def entry() -> None:
    main(OpenaiAgentsAdapter())


if __name__ == "__main__":
    entry()
