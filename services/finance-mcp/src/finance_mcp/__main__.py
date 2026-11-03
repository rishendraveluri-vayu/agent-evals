"""Run the server: `finance-mcp --transport stdio|http [...]` or `python -m finance_mcp ...`.

Logs go to stderr only; on stdio, stdout carries the protocol and nothing else.
"""

import argparse
import logging
import os
from pathlib import Path

from finance_mcp import __version__
from finance_mcp.client_data import CLIENT_FILE
from finance_mcp.server import create_server

log = logging.getLogger("finance_mcp")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="finance-mcp",
        description="MCP tool server for Indian personal finance (deterministic calculators "
        "and read-only client data).",
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        required=True,
        help="stdio, or streamable HTTP at /mcp. No default: the caller picks.",
    )
    parser.add_argument(
        "--host", default="127.0.0.1", help="HTTP bind address (default 127.0.0.1)."
    )
    parser.add_argument("--port", type=int, default=8090, help="HTTP port (default 8090).")
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=None,
        help=f"Per-trial state directory; the client is read from <dir>/{CLIENT_FILE}. "
        "Default: $FINANCE_STATE_DIR, else no client on file.",
    )
    return parser.parse_args(argv)


def resolve_state_dir(flag: Path | None) -> Path | None:
    if flag is not None:
        return flag
    env = os.environ.get("FINANCE_STATE_DIR")
    return Path(env) if env else None


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    state_dir = resolve_state_dir(args.state_dir)
    server = create_server(state_dir)  # configures logging to stderr

    if state_dir is None:
        log.warning("no state directory set: client-data tools will report no client on file")
    elif not state_dir.is_dir():
        log.warning("state directory %s does not exist yet: read on each call", state_dir)
    log.info("finance-mcp %s: transport=%s state_dir=%s", __version__, args.transport, state_dir)

    if args.transport == "stdio":
        server.run("stdio")
    else:
        # Stateless with plain JSON responses: no session survives between requests, which suits
        # a server whose only state is the client file it re-reads on every call.
        server.run(
            "streamable-http",
            host=args.host,
            port=args.port,
            stateless_http=True,
            json_response=True,
        )


if __name__ == "__main__":
    main()
