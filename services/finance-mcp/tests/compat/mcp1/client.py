"""An mcp 1.x client, run by tests/test_compat_mcp1.py inside this folder's locked environment.

It connects the way langchain-mcp-adapters 0.3.2 does (ClientSession over stdio_client or
streamable_http_client, then initialize), lists the tools, makes the calls it is given, and
prints one JSON object on stdout.

Config on stdin: {"transport": "stdio"|"http", "url": str, "command": str, "args": [str],
"calls": [[name, arguments], ...]}
"""

import asyncio
import importlib.metadata
import json
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client


async def exercise(session: ClientSession, calls: list) -> dict:
    init = await session.initialize()
    tools = await session.list_tools()
    results = []
    for name, arguments in calls:
        result = await session.call_tool(name, arguments)
        results.append(
            {
                "is_error": bool(result.isError),
                "content": [
                    block.model_dump(mode="json", exclude_none=True) for block in result.content
                ],
                "structured": result.structuredContent,
            }
        )
    return {
        "mcp_version": importlib.metadata.version("mcp"),
        "protocol_version": init.protocolVersion,
        "server_name": init.serverInfo.name,
        "tools": [
            tool.model_dump(mode="json", by_alias=True, exclude_none=True) for tool in tools.tools
        ],
        "results": results,
    }


async def main() -> None:
    config = json.load(sys.stdin)
    if config["transport"] == "stdio":
        params = StdioServerParameters(command=config["command"], args=config["args"])
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            output = await exercise(session, config["calls"])
    else:
        async with (
            streamable_http_client(config["url"]) as (read, write, _),
            ClientSession(read, write) as session,
        ):
            output = await exercise(session, config["calls"])
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
