"""In-memory server state: fault attempt counters and the request capture buffer.

Both are guarded by a threading.Lock. Under uvicorn every request runs on one event loop and
these methods never await, so they are already atomic there; the lock also keeps them correct
if they are called from several threads (tests, or a threaded server). State is per process:
run the server with a single worker.
"""

import itertools
import threading
import time
from collections import deque
from datetime import UTC, datetime
from typing import Any


class FaultCounter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._attempts: dict[str, int] = {}

    def should_fire(self, identity: str, times: int | None) -> bool:
        """Count this attempt and say whether the fault fires. `times=None` fires every time."""
        if times is None:
            return True
        with self._lock:
            seen = self._attempts.get(identity, 0)
            self._attempts[identity] = seen + 1
        return seen < times

    def reset(self) -> int:
        with self._lock:
            cleared = len(self._attempts)
            self._attempts.clear()
        return cleared


class RequestLog:
    """Ring buffer of captured requests, oldest first. Sequence numbers never restart."""

    def __init__(self, maxlen: int = 2000) -> None:
        self._lock = threading.Lock()
        self._entries: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._seq = itertools.count(1)

    def add(self, **fields: Any) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            entry = {
                "seq": next(self._seq),
                "ts": now,
                "time": datetime.fromtimestamp(now, UTC).isoformat(timespec="milliseconds"),
                "outcome": "pending",
                **fields,
            }
            self._entries.append(entry)
        return entry

    def list(self, script: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            entries = list(self._entries)
        if script is not None:
            entries = [entry for entry in entries if entry["script"] == script]
        return entries

    def clear(self) -> int:
        with self._lock:
            cleared = len(self._entries)
            self._entries.clear()
        return cleared
