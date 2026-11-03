"""OpenTelemetry spans in OTLP JSON shape, one per line of trace.jsonl (contract v2, section 6).

One trial is one trace. A span is written when it ends, so a crash keeps every span that closed.
Spans can be started and ended from any thread: harness callbacks often run on tool threads.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any

KIND_INTERNAL = 1
KIND_CLIENT = 3
STATUS_UNSET = 0
STATUS_OK = 1
STATUS_ERROR = 2

MAX_STRING_ATTR = 16_000  # longer strings are cut and flagged, full bodies go to artifacts


def trace_id_for(trial_id: str) -> str:
    """Derived from the trial id, so every source (adapter, runner, proxy merge) agrees."""
    return hashlib.sha256(trial_id.encode()).hexdigest()[:32]


def new_span_id() -> str:
    return os.urandom(8).hex()


def now_ns() -> int:
    return time.time_ns()


def any_value(value: Any) -> dict[str, Any]:
    """Python value to an OTLP AnyValue. Dicts become JSON strings so they stay readable."""
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [any_value(v) for v in value]}}
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    if len(text) > MAX_STRING_ATTR:
        text = text[:MAX_STRING_ATTR] + f"...[truncated {len(text) - MAX_STRING_ATTR} chars]"
    return {"stringValue": text}


def attributes(attrs: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"key": k, "value": any_value(v)} for k, v in attrs.items() if v is not None]


def attr_dict(span: dict[str, Any]) -> dict[str, Any]:
    """Read a written span's attributes back into a plain dict (for tests and tools)."""
    out: dict[str, Any] = {}
    for item in span.get("attributes", []):
        out[item["key"]] = _plain(item["value"])
    return out


def _plain(value: dict[str, Any]) -> Any:
    if "stringValue" in value:
        return value["stringValue"]
    if "boolValue" in value:
        return value["boolValue"]
    if "intValue" in value:
        return int(value["intValue"])
    if "doubleValue" in value:
        return value["doubleValue"]
    if "arrayValue" in value:
        return [_plain(v) for v in value["arrayValue"]["values"]]
    return None


class Span:
    def __init__(
        self,
        tracer: Tracer,
        name: str,
        parent_id: str | None,
        kind: int,
        attrs: dict[str, Any] | None,
        start_ns: int | None = None,
    ) -> None:
        self.tracer = tracer
        self.name = name
        self.span_id = new_span_id()
        self.parent_id = parent_id
        self.kind = kind
        self.start_ns = start_ns or now_ns()
        self.attrs: dict[str, Any] = dict(attrs or {})
        self.events: list[dict[str, Any]] = []
        self.status_code = STATUS_UNSET
        self.status_message: str | None = None
        self.ended = False
        self._lock = threading.Lock()

    def set_attrs(self, attrs: dict[str, Any]) -> Span:
        with self._lock:
            self.attrs.update(attrs)
        return self

    def event(self, name: str, attrs: dict[str, Any] | None = None) -> None:
        with self._lock:
            ev: dict[str, Any] = {"timeUnixNano": str(now_ns()), "name": name}
            if attrs:
                ev["attributes"] = attributes(attrs)
            self.events.append(ev)

    def error(self, message: str) -> Span:
        self.status_code = STATUS_ERROR
        self.status_message = message[:2000]
        return self

    def end(self, ok: bool | None = None, message: str | None = None) -> None:
        with self._lock:
            if self.ended:
                return
            self.ended = True
            if ok is True and self.status_code != STATUS_ERROR:
                self.status_code = STATUS_OK
            elif ok is False:
                self.status_code = STATUS_ERROR
                if message:
                    self.status_message = message[:2000]
        self.tracer._write(self)

    def to_otlp(self, end_ns: int) -> dict[str, Any]:
        span: dict[str, Any] = {
            "traceId": self.tracer.trace_id,
            "spanId": self.span_id,
            "name": self.name,
            "kind": self.kind,
            "startTimeUnixNano": str(self.start_ns),
            "endTimeUnixNano": str(max(end_ns, self.start_ns)),
            "attributes": attributes(self.attrs),
            "status": {"code": self.status_code},
        }
        if self.parent_id:
            span["parentSpanId"] = self.parent_id
        if self.events:
            span["events"] = self.events
        if self.status_message:
            span["status"]["message"] = self.status_message
        return span

    def __enter__(self) -> Span:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc is not None:
            self.end(ok=False, message=f"{type(exc).__name__}: {exc}")
        else:
            self.end(ok=True)


class Tracer:
    """Writes spans to one trace.jsonl. Thread-safe. Keeps track of open spans so a timeout
    can close them all with an error before the process exits."""

    def __init__(self, path: Path, trial_id: str) -> None:
        self.path = path
        self.trace_id = trace_id_for(trial_id)
        self._lock = threading.Lock()
        self._open: dict[str, Span] = {}
        self._fh = open(path, "a", encoding="utf-8")  # noqa: SIM115 - closed in close()
        self.written = 0

    def start(
        self,
        name: str,
        parent: Span | None = None,
        kind: int = KIND_INTERNAL,
        attrs: dict[str, Any] | None = None,
        start_ns: int | None = None,
    ) -> Span:
        span = Span(self, name, parent.span_id if parent else None, kind, attrs, start_ns)
        with self._lock:
            self._open[span.span_id] = span
        return span

    def _write(self, span: Span) -> None:
        line = json.dumps(span.to_otlp(now_ns()), ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._open.pop(span.span_id, None)
            if self._fh.closed:
                return
            self._fh.write(line + "\n")
            self._fh.flush()
            self.written += 1

    def close_open(self, message: str) -> None:
        """End every open span with an error, innermost first (newest first)."""
        with self._lock:
            spans = list(self._open.values())
        for span in sorted(spans, key=lambda s: s.start_ns, reverse=True):
            span.end(ok=False, message=message)

    def close(self) -> None:
        with self._lock:
            if not self._fh.closed:
                self._fh.flush()
                os.fsync(self._fh.fileno())
                self._fh.close()


def read_spans(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    spans = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            spans.append(json.loads(line))
    return spans


def otlp_export(spans: list[dict[str, Any]], resource: dict[str, Any]) -> dict[str, Any]:
    """Wrap trace.jsonl spans as an OTLP ExportTraceServiceRequest, for standard tools."""
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": attributes(resource)},
                "scopeSpans": [{"scope": {"name": "agent-evals", "version": "2"}, "spans": spans}],
            }
        ]
    }
