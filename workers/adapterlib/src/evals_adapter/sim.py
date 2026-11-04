"""The simulated client (D22, contract v2 section 9).

A second model plays the client. It sees only the visible conversation: what the client said
and the agent's visible replies, never tool calls or results. Its replies are cached by task,
simulator settings and exact visible transcript, so every config in an experiment that reaches
the same conversation state gets the same client reply. The agent's own calls are never cached.

The cache crosses trials, so it cannot live in the wiped trial folder. The API keeps it: a claim
carries the known replies for the trial's task, simulator and prompt, the runner writes them to
/trial/sim_cache.json before the trial, and the API stores the new ones from the uploaded
/trial/out/sim_replies.jsonl when the trial is reported (docs/api-contract.md).
"""

from __future__ import annotations

import hashlib
import json
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

END_MARKER = "[[END_CONVERSATION]]"
CACHE_VERSION = "sim-cache-1"


class SimulatorError(RuntimeError):
    """A simulator failure: its call failed (`sim_call_failed`), or its reply gave the client
    nothing to say (`sim_empty_reply`). D26: a failure the agent did not cause is
    infrastructure, so the conversation ends with ended_by sim_error and the runner labels the
    trial infra:sim_error. It is never the client ending the conversation."""

    def __init__(
        self,
        message: str,
        kind: str = "sim_call_failed",
        key: str | None = None,
        cache_hit: bool | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.key = key
        self.cache_hit = cache_hit


@dataclass
class ClientReply:
    message: str | None  # None when the client only ended the conversation
    done: bool
    cache_hit: bool
    key: str
    usage: dict[str, Any] | None


NO_CLIENT_FILE = "(There is no client file for you.)"


def render_prompt(template: str, sim: dict[str, Any]) -> str:
    """Fill the versioned simulator prompt. Placeholders are {{persona}}, {{client_summary}}
    (D27: the API's summary of the task's client file, or a line saying there is none),
    {{hidden_facts}}, {{concerns}}, {{goal}} and {{end_marker}}. A template without a placeholder
    simply does not use that value (client-sim v1 has no {{client_summary}})."""

    def bullets(items: list[str]) -> str:
        return "\n".join(f"- {item}" for item in items) if items else "- (none)"

    values = {
        "persona": sim["persona"],
        "client_summary": sim.get("client_summary") or NO_CLIENT_FILE,
        "hidden_facts": bullets(sim["hidden_facts"]),
        "concerns": bullets(sim["concerns"]),
        "goal": sim["goal"],
        "end_marker": END_MARKER,
    }
    text = template
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def client_view(transcript: list[dict[str, str]]) -> list[dict[str, str]]:
    """The conversation from the client's side: the client's own messages are `assistant`, the
    agent's replies are `user`."""
    flipped = []
    for turn in transcript:
        role = "assistant" if turn["role"] == "user" else "user"
        flipped.append({"role": role, "content": turn["content"]})
    return flipped


def cache_key(spec: dict[str, Any], transcript: list[dict[str, str]]) -> str:
    """One conversation state. A null temperature (not sent, D27) is part of the key as null.
    The client summary is in the key only when the spec has one, so keys made before D27 are
    unchanged."""
    sim = spec["task"]["client_sim"]
    model = sim["model"]
    material = {
        "v": CACHE_VERSION,
        "task_id": spec["trial"]["task_id"],
        "task_version": spec["trial"].get("task_version"),
        "sim_model": model["name"],
        "temperature": model.get("temperature"),
        "max_output_tokens": model["max_output_tokens"],
        "prompt_sha256": model["prompt"]["sha256"],
        "transcript": [{"role": t["role"], "content": t["content"]} for t in transcript],
    }
    if sim.get("client_summary") is not None:
        material["client_summary"] = sim["client_summary"]
    blob = json.dumps(material, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(blob.encode()).hexdigest()


def parse_reply(text: str) -> tuple[str | None, bool]:
    done = END_MARKER in text
    message = text.replace(END_MARKER, "").strip()
    return (message or None), done


def empty_reply(message: str | None, done: bool, client_has_spoken: bool) -> str | None:
    """Why a parsed reply is a simulator failure, or None when it is usable.

    A reply with no text is a failure, with or without the end marker. The one exception is the
    end marker alone once the client has already sent a message of its own in this conversation:
    its goodbye came in that earlier message, so this is a normal client ending. The library
    cannot tell whether that earlier message really was a goodbye (docs/assumptions.md A10)."""
    if message is not None:
        return None
    if done and client_has_spoken:
        return None
    if done:
        return "reply holds only the end marker, before the client has said anything"
    return "reply has no text"


def _usage_note(usage: Any, finish_reason: Any) -> str:
    """Why a reply may be empty, from the response: '(finish_reason length; 300 output tokens,
    300 of them reasoning)'. Empty when the response says neither."""
    parts = []
    if finish_reason:
        parts.append(f"finish_reason {finish_reason}")
    if isinstance(usage, dict) and usage.get("completion_tokens") is not None:
        note = f"{usage['completion_tokens']} output tokens"
        details = usage.get("completion_tokens_details")
        if isinstance(details, dict) and details.get("reasoning_tokens") is not None:
            note += f", {details['reasoning_tokens']} of them reasoning"
        parts.append(note)
    return f" ({'; '.join(parts)})" if parts else ""


class ClientSimulator:
    def __init__(
        self,
        spec: dict[str, Any],
        api_key: str,
        cache_path: Path,
        replies_path: Path,
        timeout_s: float = 60.0,
    ) -> None:
        self.spec = spec
        self.sim = spec["task"]["client_sim"]
        self.model = self.sim["model"]
        self.api_key = api_key
        self.replies_path = replies_path
        self.timeout_s = timeout_s
        self.system_prompt = render_prompt(self.model["prompt"]["text"], self.sim)
        self._lock = threading.Lock()
        self.cache: dict[str, str] = {}
        if cache_path.exists():
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.cache = dict(data.get("replies", {}))

    def next(
        self, transcript: list[dict[str, str]], client_has_spoken: bool = False
    ) -> ClientReply:
        """The client's next reply. `client_has_spoken` says whether the simulator has already
        sent a message of its own in this conversation (see `empty_reply`).

        Raises SimulatorError when the call fails or the reply is empty. An empty reply is still
        written to sim_replies.jsonl, raw and with its usage, so a reply that went entirely to
        reasoning stays visible; its row carries `error`, and it is never cached, here or by the
        API, so a re-queued attempt asks the simulator again."""
        key = cache_key(self.spec, transcript)
        if key in self.cache:
            message, done = parse_reply(self.cache[key])
            problem = empty_reply(message, done, client_has_spoken)
            if problem is not None:
                raise SimulatorError(f"cached simulator {problem}", "sim_empty_reply", key, True)
            return ClientReply(message, done, True, key, None)
        raw, usage, finish_reason = self._call(transcript, key)
        message, done = parse_reply(raw)
        problem = empty_reply(message, done, client_has_spoken)
        with self._lock:
            row: dict[str, Any] = {
                "key": key,
                "reply": raw,
                "model": self.model["name"],
                "usage": usage,
            }
            if problem is None:
                self.cache[key] = raw
            else:
                row["error"] = problem
            with open(self.replies_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        if problem is not None:
            note = _usage_note(usage, finish_reason)
            raise SimulatorError(f"simulator {problem}{note}", "sim_empty_reply", key, False)
        return ClientReply(message, done, False, key, usage)

    def _call(
        self, transcript: list[dict[str, str]], key: str | None = None
    ) -> tuple[str, dict[str, Any] | None, str | None]:
        """The raw reply text, the response's usage and its finish_reason."""
        body: dict[str, Any] = {
            "model": self.model["name"],
            "messages": [{"role": "system", "content": self.system_prompt}]
            + client_view(transcript),
            "max_tokens": self.model["max_output_tokens"],
            "stream": False,
        }
        # D27: a null temperature is not sent, so the model's default applies (Haiku 5.5 refuses
        # any temperature); the reply cache keeps the conversation repeatable.
        if self.model.get("temperature") is not None:
            body["temperature"] = self.model["temperature"]
        url = self.model["base_url"].rstrip("/") + "/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        failed = "sim_call_failed"
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310
                payload = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:500]
            message = f"simulator call failed: HTTP {exc.code}: {detail}"
            raise SimulatorError(message, failed, key, False) from exc
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise SimulatorError(f"simulator call failed: {exc}", failed, key, False) from exc
        try:
            choice = payload["choices"][0]
            content = choice["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            message = f"simulator reply has no message: {str(payload)[:300]}"
            raise SimulatorError(message, failed, key, False) from exc
        if not isinstance(content, str):
            message = f"simulator reply content is not text: {str(content)[:300]}"
            raise SimulatorError(message, failed, key, False)
        return content, payload.get("usage"), choice.get("finish_reason")
