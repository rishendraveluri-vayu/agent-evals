from pathlib import Path

import pytest
from finance_mcp.__main__ import parse_args, resolve_state_dir


def test_transport_is_required_and_has_no_default() -> None:
    with pytest.raises(SystemExit):
        parse_args([])
    with pytest.raises(SystemExit):
        parse_args(["--transport", "sse"])
    args = parse_args(["--transport", "http"])
    assert (args.transport, args.host, args.port, args.state_dir) == (
        "http",
        "127.0.0.1",
        8090,
        None,
    )


def test_state_dir_flag_wins_over_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINANCE_STATE_DIR", "/from/env")
    assert resolve_state_dir(Path("/from/flag")) == Path("/from/flag")
    assert resolve_state_dir(None) == Path("/from/env")
    monkeypatch.delenv("FINANCE_STATE_DIR")
    assert resolve_state_dir(None) is None
    monkeypatch.setenv("FINANCE_STATE_DIR", "")
    assert resolve_state_dir(None) is None
