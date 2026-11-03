"""Raw ASGI responses the fake needs beyond Starlette's: streams that can break on purpose,
truncated bodies, and sleeps that stop when the client goes away.

Breaking a connection: the ASGI app sends part of a response and returns without the final
`more_body: False` message. uvicorn then logs "ASGI callable returned without completing
response." and closes the TCP connection, so the client sees an incomplete chunked stream or a
body shorter than its Content-Length. That log line is expected for these faults.
"""

from collections.abc import Callable
from typing import Any

import anyio

Scope = dict[str, Any]
Receive = Callable[[], Any]
Send = Callable[[dict[str, Any]], Any]
OnDone = Callable[[str], None]


async def sleep_unless_disconnected(receive: Receive, seconds: float) -> bool:
    """Sleep for `seconds`. Return True early if the client disconnects first.

    Call only after the request body has been read: the next `receive()` then blocks until
    the client disconnects, which is what this waits for alongside the sleep.
    """
    if seconds <= 0:
        return False
    disconnected = False

    async def watch(scope: anyio.CancelScope) -> None:
        nonlocal disconnected
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                disconnected = True
                scope.cancel()
                return

    async with anyio.create_task_group() as group:
        group.start_soon(watch, group.cancel_scope)
        await anyio.sleep(seconds)
        group.cancel_scope.cancel()
    return disconnected


class NoResponse:
    """Used when the client disconnected before we answered: there is no one to answer."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        return None


class SSEResponse:
    def __init__(
        self, events: list[bytes], *, complete: bool, chunk_delay: float, on_done: OnDone
    ) -> None:
        self.events = events
        self.complete = complete
        self.chunk_delay = chunk_delay
        self.on_done = on_done

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"text/event-stream; charset=utf-8"),
                    (b"cache-control", b"no-cache"),
                    (b"x-accel-buffering", b"no"),
                ],
            }
        )
        for position, event in enumerate(self.events):
            if position and await sleep_unless_disconnected(receive, self.chunk_delay):
                self.on_done("client_disconnected")
                return
            await send({"type": "http.response.body", "body": event, "more_body": True})
        if not self.complete:
            self.on_done("connection_dropped")
            return  # deliberately incomplete: uvicorn closes the connection
        await send({"type": "http.response.body", "body": b"", "more_body": False})
        self.on_done("completed")


class TruncatedResponse:
    """A JSON response that declares its full Content-Length, sends half, then drops."""

    def __init__(self, body: bytes, *, on_done: OnDone) -> None:
        self.body = body
        self.on_done = on_done

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(self.body)).encode()),
                ],
            }
        )
        half = self.body[: len(self.body) // 2]
        await send({"type": "http.response.body", "body": half, "more_body": True})
        self.on_done("connection_dropped")
