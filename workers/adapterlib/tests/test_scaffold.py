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


def test_scaffold_refuses_an_existing_folder_and_bad_names(tmp_path):
    scaffold("adk", tmp_path)
    with pytest.raises(FileExistsError):
        scaffold("adk", tmp_path)
    for bad in ("ADK", "1adk", "a/b", "my_adk"):
        with pytest.raises(ValueError):
            scaffold(bad, tmp_path)
