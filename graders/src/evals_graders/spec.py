"""Grader specs: validation against the JSON Schema, and each grader's version."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

import jsonschema

from evals_graders import FRAMEWORK_VERSION
from evals_graders.canonical import grader_version, spec_sha256
from evals_graders.judge import rubric_path

DEFAULT_UNIT_FILE = "grader.py"


@cache
def schema() -> dict[str, Any]:
    text = resources.files("evals_graders").joinpath("grader-spec.schema.json").read_text("utf-8")
    return json.loads(text)


@cache
def _validator() -> jsonschema.Draft202012Validator:
    return jsonschema.Draft202012Validator(schema())


def problems(spec: Any) -> list[str]:
    """Plain-words schema errors for one grader spec; empty when it is valid."""
    if not isinstance(spec, dict):
        return ["a grader spec must be a JSON object"]
    out = []
    for err in sorted(_validator().iter_errors(spec), key=lambda e: list(e.absolute_path)):
        where = ".".join(str(p) for p in err.absolute_path) or "(spec)"
        out.append(f"{where}: {err.message}")
    if not out and spec.get("type") in ("regex_present", "regex_absent"):
        try:
            re.compile(spec["pattern"])
        except re.error as exc:
            out.append(f"pattern: not a valid regular expression ({exc})")
    return out


def unit_file(spec: dict[str, Any]) -> str | None:
    return spec.get("file", DEFAULT_UNIT_FILE) if spec.get("type") == "unit_test" else None


def file_sha256(path: Path) -> str | None:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


@dataclass(frozen=True)
class Prepared:
    """One grader, ready to run: its spec, the hash of what it is, and its version."""

    spec: dict[str, Any]
    spec_sha256: str
    version: str
    problems: tuple[str, ...]

    @property
    def id(self) -> str:
        value = self.spec.get("id") if isinstance(self.spec, dict) else None
        return value if isinstance(value, str) else "?"

    @property
    def type(self) -> str:
        value = self.spec.get("type") if isinstance(self.spec, dict) else None
        return value if isinstance(value, str) else "?"

    @property
    def required(self) -> bool:
        return not isinstance(self.spec, dict) or self.spec.get("required", True) is not False


def prepare(
    specs: list[Any],
    task_dir: Path | None,
    spec_hashes: list[str] | None = None,
    framework_version: str = FRAMEWORK_VERSION,
    repo_root: Path | None = None,
) -> list[Prepared]:
    """Validates every spec and computes its version.

    `spec_hashes`, when given (the grader worker), are the API's own spec hashes for these specs,
    so a grade's version is exactly what the API expects; otherwise (the CLI) they are computed
    here the same way, from the spec and the files it runs: a unit_test's grader file (in
    `task_dir`) or a judge's rubric (its configs/rubrics/ path, in `repo_root`), so editing the
    rubric gives the judge a new version.
    """
    out: list[Prepared] = []
    seen: set[str] = set()
    for i, spec in enumerate(specs):
        found = problems(spec)
        if isinstance(spec, dict) and isinstance(spec.get("id"), str):
            if spec["id"] in seen:
                found.append(f"id {spec['id']!r} is used by more than one grader in this task")
            seen.add(spec["id"])
        if spec_hashes is not None:
            sha = spec_hashes[i]
        else:
            files: dict[str, str | None] = {}
            name = unit_file(spec) if isinstance(spec, dict) else None
            if name:
                files[name] = file_sha256(task_dir / name) if task_dir else None
            is_judge = isinstance(spec, dict) and spec.get("type") == "judge"
            rubric = rubric_path(spec) if is_judge else None
            if rubric:
                files[rubric] = file_sha256(repo_root / rubric) if repo_root else None
            sha = spec_sha256(spec, files)
        out.append(Prepared(spec, sha, grader_version(sha, framework_version), tuple(found)))
    return out
