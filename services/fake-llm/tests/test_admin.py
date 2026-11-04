"""Health, models, request capture, runtime scripts, script files and env config."""

import json

import pytest
from fake_llm import __main__ as entrypoint
from fake_llm import create_app
from fake_llm.app import scripts_dir_from_env
from fake_llm.scripts import ScriptError
from fake_llm.state import RequestLog
from support import chat_body, register

EXAMPLES = {
    "default",
    "echo",
    "two-tools",
    "rate-limited",
    "flaky-stream",
    "finance-emi",
    "finance-loop",
    "finance-chat",
    "finance-malformed",
    "finance-timeout",
    "finance-429",
    "finance-429-twice",
    "finance-503",
    "finance-503-twice",
    "finance-400",
    "finance-length",
    "finance-length-always",
    "finance-emi-unsupported",
    "sim-client",
    "sim-empty",
    "judge",
}


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_models_list_scripts(client):
    body = client.get("/v1/models").json()
    assert body["object"] == "list"
    assert {m["id"] for m in body["data"]} == EXAMPLES
    register(client, "added-later", [{"text": "hi"}])
    assert "added-later" in {m["id"] for m in client.get("/v1/models").json()["data"]}


def test_capture_records_full_body_in_order(client):
    tools = [{"type": "function", "function": {"name": "search_docs", "parameters": {}}}]
    sent = chat_body(
        "fake/echo",
        messages=[{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi"}],
        temperature=0.2,
        max_tokens=256,
        tools=tools,
    )
    client.post("/v1/chat/completions", json=sent)
    client.post("/v1/chat/completions", json=chat_body("two-tools"))
    requests = client.get("/_fake/requests").json()["requests"]
    assert [r["script"] for r in requests] == ["echo", "two-tools"]
    assert requests[0]["seq"] < requests[1]["seq"]
    assert requests[0]["ts"] <= requests[1]["ts"]
    first = requests[0]
    assert first["body"] == sent
    assert first["body"]["temperature"] == 0.2
    assert first["body"]["max_tokens"] == 256
    assert first["body"]["tools"] == tools
    assert first["body"]["messages"][0]["content"] == "Be brief."
    assert first["step"] == 0
    assert first["stream"] is False
    assert first["fault"] is None
    assert first["outcome"] == "completed"
    assert first["time"].endswith("+00:00")


def test_capture_filter_and_clear(client):
    for model in ("echo", "two-tools", "echo"):
        client.post("/v1/chat/completions", json=chat_body(model))
    echo_only = client.get("/_fake/requests", params={"script": "echo"}).json()["requests"]
    assert [r["script"] for r in echo_only] == ["echo", "echo"]
    assert client.get("/_fake/requests", params={"script": "nope"}).json()["requests"] == []
    assert client.delete("/_fake/requests").json() == {"cleared": 3}
    assert client.get("/_fake/requests").json()["requests"] == []
    client.post("/v1/chat/completions", json=chat_body("echo"))
    assert client.get("/_fake/requests").json()["requests"][0]["seq"] == 4


def test_capture_is_a_bounded_ring_buffer():
    log = RequestLog(maxlen=3)
    for i in range(5):
        log.add(script="s", n=i)
    assert [e["n"] for e in log.list()] == [2, 3, 4]
    assert [e["seq"] for e in log.list()] == [3, 4, 5]


def test_register_replace_and_list_scripts(client):
    response = client.post("/_fake/scripts", json={"name": "mine", "steps": [{"text": "one"}]})
    assert response.status_code == 201
    assert response.json() == {"name": "mine", "steps": 1, "replaced": False}
    response = client.post(
        "/_fake/scripts", json={"name": "mine", "steps": [{"text": "two"}, {"text": "three"}]}
    )
    assert response.status_code == 200
    assert response.json()["replaced"] is True
    reply = client.post("/v1/chat/completions", json=chat_body("mine")).json()
    assert reply["choices"][0]["message"]["content"] == "two"
    listed = {s["name"]: s for s in client.get("/_fake/scripts").json()["scripts"]}
    assert listed["mine"]["source"] == "runtime"
    assert listed["mine"]["definition"]["steps"][1] == {"text": "three"}
    assert listed["echo"]["source"] == "file:echo.yaml"
    assert listed["default"]["source"] == "builtin"


@pytest.mark.parametrize(
    "definition",
    [
        {"steps": [{"text": "no name"}]},
        {"name": "bad name!", "steps": [{"text": "x"}]},
        {"name": "default", "steps": [{"text": "x"}]},
        {"name": "empty", "steps": []},
        {"name": "nothing", "steps": [{}]},
        {"name": "typo", "steps": [{"text": "x", "delay": 5}]},
        {"name": "kind", "steps": [{"text": "x", "fault": {"kind": "418"}}]},
        {"name": "times", "steps": [{"text": "x", "fault": {"kind": "500", "times": 0}}]},
        {"name": "mal", "steps": [{"text": "x", "fault": {"kind": "malformed_tool_call"}}]},
        {"name": "args", "steps": [{"tool_calls": [{"name": "f", "arguments": 3}]}]},
        {"name": "neg", "steps": [{"text": "x", "delay_ms": -1}]},
        {"name": "fault-times-needs-body", "steps": [{"fault": {"kind": "500", "times": 1}}]},
        {"name": "msg-kind", "steps": [{"text": "x", "fault": {"kind": "timeout", "message": ""}}]},
        {"name": "msg-type", "steps": [{"fault": {"kind": "400", "message": 4}}]},
        {"name": "len", "steps": [{"tool_calls": [{"name": "f"}], "fault": {"kind": "length"}}]},
        {"name": "len-empty", "steps": [{"text": "", "fault": {"kind": "length"}}]},
        {
            "name": "len-message",
            "steps": [{"text": "x", "fault": {"kind": "length", "message": "m"}}],
        },
    ],
)
def test_invalid_scripts_are_rejected(client, definition):
    response = client.post("/_fake/scripts", json=definition)
    assert response.status_code == 400, definition
    assert response.json()["error"]["type"] == "invalid_request_error"


def test_register_rejects_invalid_json(client):
    assert client.post("/_fake/scripts", content=b"{").status_code == 400


def test_loads_yaml_and_json_files(tmp_path):
    (tmp_path / "a.yaml").write_text("steps:\n  - text: from yaml\n")
    (tmp_path / "b.json").write_text(json.dumps({"name": "b", "steps": [{"text": "from json"}]}))
    (tmp_path / "notes.txt").write_text("ignored")
    app = create_app(tmp_path)
    names = {s.name for s in app.state.fake.registry.all()}
    assert names == {"default", "a", "b"}


@pytest.mark.parametrize(
    ("filename", "content"),
    [
        ("x.yaml", "name: y\nsteps:\n  - text: name differs from file\n"),
        ("x.yaml", "steps: [\n"),
        ("x.json", "{"),
        ("x.yaml", "- text: a bare list is not a script\n"),
    ],
)
def test_invalid_script_files_fail_at_startup(tmp_path, filename, content):
    (tmp_path / filename).write_text(content)
    with pytest.raises(ScriptError):
        create_app(tmp_path)


def test_duplicate_script_names_across_files_fail(tmp_path):
    (tmp_path / "x.yaml").write_text("steps:\n  - text: a\n")
    (tmp_path / "x.json").write_text(json.dumps({"steps": [{"text": "b"}]}))
    with pytest.raises(ScriptError, match="duplicate"):
        create_app(tmp_path)


def test_scripts_dir_from_env(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LLM_SCRIPTS_DIR", str(tmp_path))
    assert scripts_dir_from_env() == tmp_path
    monkeypatch.setenv("FAKE_LLM_SCRIPTS_DIR", str(tmp_path / "missing"))
    with pytest.raises(SystemExit):
        scripts_dir_from_env()
    monkeypatch.delenv("FAKE_LLM_SCRIPTS_DIR")
    monkeypatch.chdir(tmp_path)
    assert scripts_dir_from_env() is None
    (tmp_path / "scripts").mkdir()
    assert scripts_dir_from_env() == tmp_path / "scripts"


def test_main_reads_port_from_env(monkeypatch, tmp_path):
    calls = {}
    monkeypatch.setattr(entrypoint.uvicorn, "run", lambda app, **kw: calls.update(kw))
    monkeypatch.setenv("FAKE_LLM_SCRIPTS_DIR", str(tmp_path))
    monkeypatch.setenv("FAKE_LLM_PORT", "9123")
    entrypoint.main()
    assert calls["port"] == 9123
    assert calls["workers"] == 1
    monkeypatch.delenv("FAKE_LLM_PORT")
    entrypoint.main()
    assert calls["port"] == 8080
