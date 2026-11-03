"""Script selection: marker, then model name after the last '/', then the built-in default."""

from fake_llm.scripts import DEFAULT_TEXT
from support import chat_body


def reply_and_capture(client, body):
    response = client.post("/v1/chat/completions", json=body)
    assert response.status_code == 200, response.text
    capture = client.get("/_fake/requests").json()["requests"][-1]
    return response.json()["choices"][0]["message"], capture


def test_marker_in_user_message_selects_script(client):
    messages = [{"role": "user", "content": "Find it [[fake-script:two-tools]] please"}]
    message, capture = reply_and_capture(client, chat_body("gpt-4o", messages=messages))
    assert message["tool_calls"][0]["function"]["name"] == "search_docs"
    assert capture["script"] == "two-tools"
    assert capture["selected_by"] == "marker"
    assert capture["fell_back"] is False


def test_marker_in_system_message_and_content_parts(client):
    messages = [
        {"role": "system", "content": [{"type": "text", "text": "[[fake-script:echo]]"}]},
        {"role": "user", "content": [{"type": "text", "text": "hello"}]},
    ]
    message, capture = reply_and_capture(client, chat_body("two-tools", messages=messages))
    assert message["content"] == "echo: hello"
    assert capture["selected_by"] == "marker"


def test_marker_beats_model(client):
    messages = [{"role": "user", "content": "[[fake-script:echo]] hi"}]
    _, capture = reply_and_capture(client, chat_body("two-tools", messages=messages))
    assert capture["script"] == "echo"


def test_marker_only_read_from_first_system_and_first_user_message(client):
    messages = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "[[fake-script:two-tools]]"},
        {"role": "user", "content": "[[fake-script:two-tools]]"},
    ]
    _, capture = reply_and_capture(client, chat_body("echo", messages=messages))
    assert capture["script"] == "echo"
    assert capture["selected_by"] == "model"


def test_model_name_with_and_without_prefix(client):
    for model in ("echo", "fake/echo", "openai/fake/echo"):
        message, capture = reply_and_capture(client, chat_body(model))
        assert capture["script"] == "echo", model
        assert capture["selected_by"] == "model"
        assert message["content"].startswith("echo: ")


def test_unknown_model_falls_back_to_default_and_is_recorded(client):
    message, capture = reply_and_capture(client, chat_body("gpt-4o"))
    assert message["content"] == DEFAULT_TEXT
    assert "tool_calls" not in message
    assert capture["script"] == "default"
    assert capture["requested_script"] == "gpt-4o"
    assert capture["fell_back"] is True


def test_unknown_marker_falls_back_without_trying_model(client):
    messages = [{"role": "user", "content": "[[fake-script:nope]]"}]
    _, capture = reply_and_capture(client, chat_body("echo", messages=messages))
    assert capture["script"] == "default"
    assert capture["requested_script"] == "nope"
    assert capture["selected_by"] == "marker"
    assert capture["fell_back"] is True


def test_no_model_and_no_marker_uses_default_without_fallback_flag(client):
    _, capture = reply_and_capture(client, {"messages": [{"role": "user", "content": "hi"}]})
    assert capture["script"] == "default"
    assert capture["selected_by"] == "default"
    assert capture["fell_back"] is False
