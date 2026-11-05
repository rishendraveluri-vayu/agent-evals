#!/usr/bin/env python3
"""Append the platform's own model calls (D38) to the "System calls" table in docs/cost.md.

Reads GET /api/spend/system from the running API and appends one row for each settled call that
is not in the table yet (matched by its id), oldest first. A call still pending is left for a
later run. Stdlib only; it makes no model call and changes nothing in the API.

    python3 scripts/log_system_spend.py           # API on 127.0.0.1:$API_PORT (default 3000)
    python3 scripts/log_system_spend.py --api http://127.0.0.1:3000/api   # or API_PORT
    python3 scripts/log_system_spend.py --from-file rows.json --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

COST_MD = Path(__file__).resolve().parent.parent / "docs" / "cost.md"
START = "<!-- system-calls:start -->"
END = "<!-- system-calls:end -->"


def _tokens(value: int | None) -> str:
    return "" if value is None else f"{value:,}"


def table_row(r: dict) -> str:
    ref = str(r.get("ref") or "")
    if ref.startswith("config:sha256:"):
        ref = "config " + ref[len("config:sha256:") :][:12]
    cost = "unknown" if r.get("cost_usd") is None else f"${r['cost_usd']:.4f}"
    cells = [
        str(r.get("created_at") or "")[:10],
        f"`{r['id']}`",
        str(r.get("kind") or ""),
        str(r.get("model") or ""),
        ref,
        str(r.get("status") or ""),
        _tokens(r.get("input_tokens")),
        _tokens(r.get("output_tokens")),
        cost,
        str(r.get("cost_source") or ""),
    ]
    return "| " + " | ".join(cells) + " |"


def merge(text: str, rows: list[dict]) -> tuple[str, list[str]]:
    """`text` with a row for each settled call not yet between the markers, and those rows."""
    start, end = text.find(START), text.find(END)
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"{COST_MD.name} has no {START} ... {END} block")
    block = text[start:end]
    settled = [r for r in rows if r.get("status") in ("done", "failed")]
    new = [
        table_row(r)
        for r in sorted(settled, key=lambda r: (r.get("created_at") or "", r["id"]))
        if f"`{r['id']}`" not in block
    ]
    if not new:
        return text, []
    head = text[:end] if text[:end].endswith("\n") else text[:end] + "\n"
    return head + "".join(line + "\n" for line in new) + text[end:], new


def fetch(api: str) -> list[dict]:
    with urllib.request.urlopen(f"{api.rstrip('/')}/spend/system", timeout=15) as res:
        return json.loads(res.read().decode("utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    port = os.environ.get("API_PORT") or "3000"
    parser.add_argument(
        "--api", default=f"http://127.0.0.1:{port}/api", help="the API's base URL, ending in /api"
    )
    parser.add_argument(
        "--from-file", type=Path, help="read the rows from this JSON file instead of the API"
    )
    parser.add_argument("--cost-md", type=Path, default=COST_MD)
    parser.add_argument("--dry-run", action="store_true", help="print the new rows, write nothing")
    args = parser.parse_args(argv)
    rows = (
        json.loads(args.from_file.read_text(encoding="utf-8"))
        if args.from_file
        else fetch(args.api)
    )
    text = args.cost_md.read_text(encoding="utf-8")
    merged, added = merge(text, rows)
    for line in added:
        print(line)
    if args.dry_run:
        print(f"{len(added)} new row(s); nothing written (--dry-run)")
        return 0
    if added:
        args.cost_md.write_text(merged, encoding="utf-8")
    print(f"{len(added)} new row(s) appended to {args.cost_md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
