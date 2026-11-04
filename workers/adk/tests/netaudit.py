"""Run the ADK adapter with every socket connect and name lookup written to $NETAUDIT_LOG.

Python's audit hooks see each socket.connect and socket.getaddrinfo in the adapter process
(ADK, LiteLLM, httpx, the MCP client), so test_adk.py can check that nothing leaves loopback.
"""

import json
import os
import runpy
import socket
import sys

LOG = os.environ["NETAUDIT_LOG"]


def hook(event: str, args: tuple) -> None:
    if event == "socket.getaddrinfo":
        record = {"event": event, "host": str(args[0])}
    elif event == "socket.connect":
        sock, address = args
        family = sock.family.name if isinstance(sock.family, socket.AddressFamily) else sock.family
        record = {"event": event, "family": str(family), "address": str(address)}
    else:
        return
    with open(LOG, "a", encoding="utf-8") as f:  # the adapter exits with os._exit: write now
        f.write(json.dumps(record) + "\n")


sys.addaudithook(hook)
sys.argv = ["adk_adapter.adapter"]
runpy.run_module("adk_adapter.adapter", run_name="__main__", alter_sys=True)
