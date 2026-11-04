"""Script model, validation, loading and selection.

A script is a named list of steps. The step served for a request is the number of
assistant messages already in the request (stateless), clamped to the last step.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

DEFAULT_SCRIPT = "default"
DEFAULT_TEXT = "This is the default reply from the fake LLM."
NAME_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]*"
NAME_RE = re.compile(rf"^{NAME_PATTERN}$")
MARKER_RE = re.compile(rf"\[\[fake-script:({NAME_PATTERN})\]\]")
LAST_USER_PLACEHOLDER = "{{last_user_message}}"
SCRIPT_SUFFIXES = (".yaml", ".yml", ".json")

# Faults that answer with an HTTP error status instead of serving the step.
STATUS_FAULTS = ("400", "401", "403", "404", "429", "500", "502", "503")
FAULT_KINDS = (*STATUS_FAULTS, "timeout", "broken_stream", "malformed_tool_call", "length")
STEP_KEYS = {"text", "tool_calls", "delay_ms", "chunk_delay_ms", "fault"}
FAULT_KEYS = {"kind", "times", "retry_after", "seconds", "message"}
SCRIPT_KEYS = {"name", "description", "steps"}


class ScriptError(ValueError):
    """A script definition is invalid."""


@dataclass(frozen=True)
class ToolCallSpec:
    name: str
    arguments: str  # the exact argument string the model "emits"


@dataclass(frozen=True)
class Fault:
    kind: str
    times: int | None = None  # None means the fault fires on every attempt
    retry_after: float = 1.0  # 429 only
    seconds: float = 30.0  # timeout only
    message: str | None = None  # status faults only: replaces the default error message


@dataclass(frozen=True)
class Step:
    text: str | None = None
    tool_calls: tuple[ToolCallSpec, ...] = ()
    delay_ms: float = 0
    chunk_delay_ms: float = 0
    fault: Fault | None = None


@dataclass(frozen=True)
class Script:
    name: str
    steps: tuple[Step, ...]
    source: str
    definition: dict[str, Any]
    description: str | None = None

    def step_for(self, assistant_messages: int) -> tuple[int, Step]:
        """Return (served index, step). Past the last step, the last step is served again."""
        index = min(assistant_messages, len(self.steps) - 1)
        return index, self.steps[index]


def _number(value: Any, field: str, *, minimum: float = 0) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or value < minimum:
        raise ScriptError(f"{field} must be a number >= {minimum}, got {value!r}")
    return value


def _parse_fault(data: Any, where: str, has_tool_calls: bool, has_text: bool) -> Fault:
    if not isinstance(data, dict):
        raise ScriptError(f"{where}.fault must be an object")
    unknown = set(data) - FAULT_KEYS
    if unknown:
        raise ScriptError(f"{where}.fault has unknown keys: {sorted(unknown)}")
    kind = str(data.get("kind"))  # YAML reads `kind: 429` as an int
    if kind not in FAULT_KINDS:
        raise ScriptError(f"{where}.fault.kind must be one of {list(FAULT_KINDS)}, got {kind!r}")
    times = data.get("times")
    if times is not None and (isinstance(times, bool) or not isinstance(times, int) or times < 1):
        raise ScriptError(f"{where}.fault.times must be an integer >= 1, got {times!r}")
    if kind == "malformed_tool_call" and not has_tool_calls:
        raise ScriptError(f"{where}: malformed_tool_call needs a step with tool_calls")
    if kind == "length" and not has_text:
        raise ScriptError(f"{where}: length needs a step with non-empty text")
    message = data.get("message")
    if message is not None and (kind not in STATUS_FAULTS or not isinstance(message, str)):
        raise ScriptError(f"{where}.fault.message must be a string, on a status fault only")
    return Fault(
        kind=kind,
        times=times,
        retry_after=_number(data.get("retry_after", 1), f"{where}.fault.retry_after"),
        seconds=_number(data.get("seconds", 30), f"{where}.fault.seconds"),
        message=message,
    )


def _parse_tool_call(data: Any, where: str) -> ToolCallSpec:
    if not isinstance(data, dict) or set(data) - {"name", "arguments"}:
        raise ScriptError(f"{where} must be an object with 'name' and optional 'arguments'")
    name = data.get("name")
    if not isinstance(name, str) or not name:
        raise ScriptError(f"{where}.name must be a non-empty string")
    arguments = data.get("arguments", {})
    if isinstance(arguments, dict):
        arguments = json.dumps(arguments, ensure_ascii=False)
    elif not isinstance(arguments, str):
        raise ScriptError(f"{where}.arguments must be an object or a raw string")
    return ToolCallSpec(name=name, arguments=arguments)


def _parse_step(data: Any, where: str) -> Step:
    if not isinstance(data, dict):
        raise ScriptError(f"{where} must be an object")
    unknown = set(data) - STEP_KEYS
    if unknown:
        raise ScriptError(f"{where} has unknown keys: {sorted(unknown)}")
    text = data.get("text")
    if text is not None and not isinstance(text, str):
        raise ScriptError(f"{where}.text must be a string")
    raw_calls = data.get("tool_calls", [])
    if not isinstance(raw_calls, list):
        raise ScriptError(f"{where}.tool_calls must be a list")
    tool_calls = tuple(
        _parse_tool_call(call, f"{where}.tool_calls[{i}]") for i, call in enumerate(raw_calls)
    )
    fault = None
    if data.get("fault") is not None:
        fault = _parse_fault(data["fault"], where, bool(tool_calls), bool(text))
    # A step needs something to serve, unless its fault fires forever and never serves it.
    never_serves = fault is not None and fault.times is None and fault.kind in STATUS_FAULTS
    if text is None and not tool_calls and not never_serves:
        raise ScriptError(f"{where} needs 'text' or 'tool_calls'")
    return Step(
        text=text,
        tool_calls=tool_calls,
        delay_ms=_number(data.get("delay_ms", 0), f"{where}.delay_ms"),
        chunk_delay_ms=_number(data.get("chunk_delay_ms", 0), f"{where}.chunk_delay_ms"),
        fault=fault,
    )


def parse_script(data: Any, *, source: str, name: str | None = None) -> Script:
    """Validate a script definition. `name` (from a file stem) is used if the body has none."""
    if not isinstance(data, dict):
        raise ScriptError(f"{source}: a script must be an object with 'steps'")
    unknown = set(data) - SCRIPT_KEYS
    if unknown:
        raise ScriptError(f"{source}: unknown keys {sorted(unknown)}")
    body_name = data.get("name")
    if name is not None and body_name is not None and body_name != name:
        raise ScriptError(f"{source}: 'name' is {body_name!r} but the file name says {name!r}")
    name = body_name if body_name is not None else name
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise ScriptError(f"{source}: script name must match {NAME_PATTERN}, got {name!r}")
    if name == DEFAULT_SCRIPT:
        raise ScriptError(f"{source}: '{DEFAULT_SCRIPT}' is built in and cannot be replaced")
    description = data.get("description")
    if description is not None and not isinstance(description, str):
        raise ScriptError(f"{source}: description must be a string")
    raw_steps = data.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ScriptError(f"{source}: 'steps' must be a non-empty list")
    steps = tuple(_parse_step(step, f"{name}.steps[{i}]") for i, step in enumerate(raw_steps))
    try:
        definition = json.loads(json.dumps({**data, "name": name}))
    except TypeError as exc:
        raise ScriptError(f"{source}: definition is not JSON-serialisable: {exc}") from exc
    return Script(
        name=name, steps=steps, source=source, definition=definition, description=description
    )


def builtin_default() -> Script:
    definition = {"name": DEFAULT_SCRIPT, "steps": [{"text": DEFAULT_TEXT}]}
    return Script(
        name=DEFAULT_SCRIPT,
        steps=(Step(text=DEFAULT_TEXT),),
        source="builtin",
        definition=definition,
        description="Built-in fallback: fixed text, never calls tools.",
    )


def load_dir(path: Path) -> list[Script]:
    """Load every .yaml/.yml/.json file in `path`. Any invalid file is an error."""
    scripts: dict[str, Script] = {}
    for file in sorted(path.iterdir()):
        if file.suffix not in SCRIPT_SUFFIXES or not file.is_file():
            continue
        text = file.read_text(encoding="utf-8")
        try:
            data = json.loads(text) if file.suffix == ".json" else yaml.safe_load(text)
        except (json.JSONDecodeError, yaml.YAMLError) as exc:
            raise ScriptError(f"{file}: cannot parse: {exc}") from exc
        script = parse_script(data, source=f"file:{file.name}", name=file.stem)
        if script.name in scripts:
            raise ScriptError(f"{file}: duplicate script name {script.name!r}")
        scripts[script.name] = script
    return list(scripts.values())


class Registry:
    """Scripts by name. Mutated only from the event loop thread, so no lock is needed."""

    def __init__(self) -> None:
        default = builtin_default()
        self._scripts: dict[str, Script] = {default.name: default}

    def add(self, script: Script) -> bool:
        """Add or replace a script. Returns True if it replaced an existing one."""
        replaced = script.name in self._scripts
        self._scripts[script.name] = script
        return replaced

    def get(self, name: str) -> Script | None:
        return self._scripts.get(name)

    @property
    def default(self) -> Script:
        return self._scripts[DEFAULT_SCRIPT]

    def all(self) -> list[Script]:
        return [self._scripts[name] for name in sorted(self._scripts)]


def message_text(content: Any) -> str:
    """Plain text of a message's content: a string, or a list of content parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            part["text"] if isinstance(part, dict) else part
            for part in content
            if isinstance(part, str)
            or (isinstance(part, dict) and isinstance(part.get("text"), str))
        ]
        return "\n".join(parts)
    return ""


def find_marker(messages: list[Any]) -> str | None:
    """Search the first system (or developer) message and the first user message, in order."""
    seen: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        group = "system" if role in ("system", "developer") else role
        if group not in ("system", "user") or group in seen:
            continue
        seen.add(group)
        match = MARKER_RE.search(message_text(message.get("content")))
        if match:
            return match.group(1)
    return None


@dataclass(frozen=True)
class Selection:
    script: Script
    requested: str | None  # the name asked for, before any fallback
    selected_by: str  # "marker", "model" or "default"
    fell_back: bool  # a name was asked for but no such script exists


def select_script(body: dict[str, Any], registry: Registry) -> Selection:
    """Marker first, then the model name after its last '/', then the built-in default.

    The first source that names a script decides. An unknown name goes to the default
    (it does not try the next source) and the selection records that it fell back.
    """
    requested, selected_by = find_marker(body.get("messages") or []), "marker"
    if requested is None:
        model = body.get("model")
        if isinstance(model, str) and model.rsplit("/", 1)[-1].strip():
            requested, selected_by = model.rsplit("/", 1)[-1].strip(), "model"
    if requested is None:
        return Selection(registry.default, None, "default", False)
    script = registry.get(requested)
    if script is None:
        return Selection(registry.default, requested, selected_by, True)
    return Selection(script, requested, selected_by, False)
