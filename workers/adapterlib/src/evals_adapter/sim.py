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
    """The simulator call failed. The trial ends as harness_error: it is infrastructure, not
    the agent."""


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

    def next(self, transcript: list[dict[str, str]]) -> ClientReply:
        key = cache_key(self.spec, transcript)
        if key in self.cache:
            message, done = parse_reply(self.cache[key])
            return ClientReply(message, done, True, key, None)
        raw, usage = self._call(transcript)
        with self._lock:
            self.cache[key] = raw
            with open(self.replies_path, "a", encoding="utf-8") as fh:
                row = {"key": key, "reply": raw, "model": self.model["name"], "usage": usage}
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        message, done = parse_reply(raw)
        return ClientReply(message, done, False, key, usage)

    def _call(self, transcript: list[dict[str, str]]) -> tuple[str, dict[str, Any] | None]:
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
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310
                payload = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:500]
            raise SimulatorError(f"simulator call failed: HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise SimulatorError(f"simulator call failed: {exc}") from exc
        try:
            content = payload["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise SimulatorError(f"simulator reply has no message: {str(payload)[:300]}") from exc
        return content, payload.get("usage")
