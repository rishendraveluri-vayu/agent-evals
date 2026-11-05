"""The new-harness scaffold writes a folder that is valid before any code is written."""

import json
import py_compile

import pytest
from support import errors

from evals_adapter.scaffold import scaffold


def test_scaffold_writes_a_valid_starting_point(tmp_path):
    root = scaffold("lang-graph", tmp_path)
    pkg = root / "src" / "lang_graph_adapter"
    expected = {
        "pyproject.toml",
        "README.md",
        ".python-version",
        "probe.sh",
        "Dockerfile",
        "tests/test_gate.py",
        "tests/test_capabilities.py",
        "src/lang_graph_adapter/__init__.py",
        "src/lang_graph_adapter/adapter.py",
        "src/lang_graph_adapter/capabilities.json",
    }
    assert {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()} == expected
    caps = json.loads((pkg / "capabilities.json").read_text())
    assert errors("capabilities", caps) == []
    assert caps["harness"] == "lang-graph"
    assert [n for n, s in caps["settings"].items() if s["supported"]] == ["timeout_s"]
    for py in root.rglob("*.py"):
        py_compile.compile(str(py), doraise=True)
    adapter = (pkg / "adapter.py").read_text()
    assert "class LangGraphAdapter(Adapter):" in adapter and "IMPLEMENTED = False" in adapter
    assert 'module-name = "lang_graph_adapter"' in (root / "pyproject.toml").read_text()
    assert (root / "probe.sh").stat().st_mode & 0o111
    # The image is built like every other worker's: its name, its module, the worker entrypoint.
    docker = (root / "Dockerfile").read_text()
    assert "COPY workers/lang-graph/src ./src" in docker
    assert "EVALS_HARNESS=lang-graph" in docker
    assert 'EVALS_ADAPTER_CMD="/opt/harness/bin/python -m lang_graph_adapter.adapter"' in docker
    assert 'ENTRYPOINT ["/opt/harness/bin/evals-worker"]' in docker
    assert "ownloop" not in docker.replace("workers/ownloop/Dockerfile", "")
    assert (root / ".python-version").read_text() == "3.14\n"


def test_scaffold_refuses_an_existing_folder_and_bad_names(tmp_path):
    scaffold("adk", tmp_path)
    with pytest.raises(FileExistsError):
        scaffold("adk", tmp_path)
    for bad in ("ADK", "1adk", "a/b", "my_adk"):
        with pytest.raises(ValueError):
            scaffold(bad, tmp_path)


def test_the_template_matches_the_own_loop_image(tmp_path):
    """Built from workers/ownloop/Dockerfile: the same but for the harness's name and module."""
    from pathlib import Path

    root = scaffold("ownloop", tmp_path)
    own = (Path(__file__).resolve().parents[2] / "ownloop" / "Dockerfile").read_text()
    made = (root / "Dockerfile").read_text().replace("ownloop_adapter.adapter", "ownloop.adapter")

    def strip(text):
        return [line for line in text.splitlines() if not line.startswith("#")]

    assert strip(made) == strip(own)


def test_main_prints_the_compose_service(tmp_path, capsys):
    from evals_adapter.scaffold import main

    with pytest.raises(SystemExit):
        main(["crew", "--workers-dir", str(tmp_path)])
    out = capsys.readouterr().out
    assert "  worker-crew:\n    <<: *harness-worker" in out
    assert "dockerfile: workers/crew/Dockerfile" in out
