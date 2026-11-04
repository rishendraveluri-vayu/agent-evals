"""No sideways page scroll on any screen, at phone, tablet, laptop and desktop widths.

Starts the Vite dev server in fixture mode (VITE_FIXTURES=1: sample data, no API, no model
calls) on a free port, opens each screen in headless Chromium at 390, 768, 1280 and 1440 px, and
checks that the page is no wider than the window: `document.documentElement.scrollWidth` at most
its `clientWidth`. Each screen is measured as it loads and again with every disclosure opened.
STATES adds screens in a state a click opens (the judge's approval form, settings refused by
their fields, the prompt editor). Two extra cases type a very long, unbroken name into the Config
screen and the guided builder,
save it (sample mode keeps it in memory only) and measure the saved config's page. When a page
is too wide, the elements that stick out are listed. Stops exactly the dev server it started.

Run from the repo root (the browsers come from ~/.cache/ms-playwright):

    uv run --no-project --with playwright==1.64.1 python apps/ui/scripts/check_overflow.py
    ... check_overflow.py --widths 390 1440 --screens trial compare --shots <folder>

Exit status 0 when every page fits, 1 when any is too wide.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

UI_DIR = Path(__file__).resolve().parent.parent
WIDTHS = [390, 768, 1280, 1440]
# Ports the stack or Rishi's machine use, and Vite's default: never these.
TAKEN = {3000, 3001, 4000, 5173, 8080}

# name -> hash route. The Run screens are left out by default (another part of the UI); add
# them with --screens run run-progress.
SCREENS = {
    "start": "#/",
    "build": "#/build",
    "experiments": "#/experiments",
    "config": "#/configs",
    "config-page": "#/configs/sha256%3A3b81e04c40d821f8210af346e05a4ff775263c73f1c541e5281257f8701430c8",
    "compare": "#/experiments/exp_heldout",
    "trial": "#/trials/tr_fd-vs-sip-07_b_3",
    "recorded": "#/trials",
    "labels": "#/labels",
    "judge": "#/labels/judge",
    "tasks": "#/tasks",
    "harnesses": "#/harnesses",
}
OPTIONAL = {"run": "#/run", "run-progress": "#/experiments/exp_harness/run"}

# Screens in a state a click or a typed value opens: name -> (route, steps). A step is
# ("click", selector), ("fill", selector, value) or ("select", selector, value).
STATES = {
    "judge-form": ("#/experiments/exp_heldout?panel=judge", [("click", '[data-test="judge-approve-open"]'), ("select", '[data-test="judge-model-select"]', "claude-haiku-5-5"), ("fill", '[data-test="judge-budget-input"]', "25")]),
    "config-problems": ("#/configs", [("fill", "#setting-max_steps", "1000000"), ("fill", "#setting-timeout_s", "soon"), ("fill", '[data-test="config-name"]', "")]),
    "build-problems": ("#/build", [("fill", "#build-max_steps", "2.5"), ("fill", "#build-timeout_s", "86400000")]),
    "prompt-editor": ("#/configs", [("click", '[data-test="new-prompt"]')]),
}

LONG_NAME = "N" * 400

MEASURE = """() => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + 1) continue;
    // Report the innermost elements only: the ones whose children all fit.
    const kids = [...el.children].some((c) => c.getBoundingClientRect().right > vw + 1);
    if (kids) continue;
    // Inside a box that scrolls or clips sideways (the phone nav, a code block) it cannot widen the page.
    let boxed = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(p).overflowX)) { boxed = true; break; }
    }
    if (boxed) continue;
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    out.push(`${el.tagName.toLowerCase()}${cls} right=${Math.round(r.right)} "${(el.innerText || '').slice(0, 60).replace(/\\s+/g, ' ')}"`);
  }
  return { scrollWidth: doc.scrollWidth, clientWidth: vw, innerWidth: window.innerWidth, offenders: out.slice(0, 8) };
}"""


def free_port() -> int:
    for _ in range(20):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in TAKEN:
            return port
    raise SystemExit("no free port found")


def start_server(port: int, log: Path) -> subprocess.Popen:
    env = {**os.environ, "VITE_FIXTURES": "1"}
    vite = UI_DIR / "node_modules" / "vite" / "bin" / "vite.js"
    proc = subprocess.Popen(
        ["node", str(vite), "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        cwd=UI_DIR,
        env=env,
        stdout=log.open("w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"the dev server exited; see {log}")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2)
            return proc
        except OSError:
            time.sleep(0.5)
    stop_server(proc)
    raise SystemExit(f"the dev server did not come up; see {log}")


def stop_server(proc: subprocess.Popen) -> None:
    """Stops the dev server this script started, and only it (its own process group)."""
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)


def settle(page: Page) -> None:
    page.wait_for_load_state("networkidle")
    page.wait_for_selector("main h1", timeout=15000)
    page.evaluate("() => document.fonts && document.fonts.ready")
    page.wait_for_timeout(400)


def open_details(page: Page) -> None:
    page.evaluate("() => document.querySelectorAll('details').forEach((d) => { d.open = true; })")
    page.wait_for_timeout(250)


def save_long_name(page: Page, base: str, where: str) -> None:
    """Types a very long unbroken name and saves; then opens the saved config's page."""
    if where == "config":
        page.goto(base + "#/configs")
        settle(page)
        # A content change, so the save is a new config rather than one that exists.
        page.fill("#setting-max_steps", "13")
        page.fill('[data-test="config-name"]', LONG_NAME)
        page.click('[data-test="save-config"]')
        page.wait_for_selector('[data-test="open-saved"]', timeout=10000)
    else:
        page.goto(base + "#/build")
        settle(page)
        # A content change, so the save is a new agent rather than one that exists.
        page.fill("#build-max_steps", "13")
        page.fill('[data-test="agent-name"]', LONG_NAME)
        page.click('[data-test="save-agent"]')
        page.wait_for_selector('[data-test="next-preview"]', timeout=10000)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--widths", type=int, nargs="+", default=WIDTHS)
    parser.add_argument("--screens", nargs="+", default=[*SCREENS, *STATES, "long-name-config", "long-name-build"])
    parser.add_argument("--shots", type=Path, help="save a full-page screenshot of each page here")
    parser.add_argument("--json", type=Path, help="write every measurement here")
    args = parser.parse_args()

    routes = {**SCREENS, **OPTIONAL}
    unknown = [s for s in args.screens if s not in routes and s not in STATES and not s.startswith("long-name-")]
    if unknown:
        raise SystemExit(f"unknown screens: {', '.join(unknown)}; known: {', '.join([*routes, *STATES, 'long-name-config', 'long-name-build'])}")
    if args.shots:
        args.shots.mkdir(parents=True, exist_ok=True)

    port = free_port()
    log = Path(os.environ.get("TMPDIR", "/tmp")) / f"agent-evals-overflow-vite-{port}.log"
    server = start_server(port, log)
    print(f"dev server pid {server.pid} on port {port} (fixture mode)")
    base = f"http://127.0.0.1:{port}/"
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width in args.widths:
                phone = width < 600
                ctx = browser.new_context(
                    viewport={"width": width, "height": 900},
                    device_scale_factor=2 if phone else 1,
                    is_mobile=phone,
                    has_touch=phone,
                )
                page = ctx.new_page()
                for name in args.screens:
                    if name.startswith("long-name-"):
                        save_long_name(page, base, name.removeprefix("long-name-"))
                        # The saved config lives in this page's memory only: change the hash, never reload.
                        link = page.get_attribute('[data-test="open-saved"]' if name.endswith("config") else '[data-test="next-preview"]', "href")
                        page.evaluate("(h) => { window.location.hash = h; }", link)
                    elif name in STATES:
                        route, steps = STATES[name]
                        page.goto(base + route)
                        settle(page)
                        for action, selector, *value in steps:
                            if action == "click":
                                page.click(selector)
                            elif action == "fill":
                                page.fill(selector, value[0])
                            else:
                                page.select_option(selector, value[0])
                        page.wait_for_timeout(250)
                    else:
                        page.goto(base + routes[name])
                    settle(page)
                    for state in ("as loaded", "disclosures open"):
                        if state == "disclosures open":
                            open_details(page)
                        m = page.evaluate(MEASURE)
                        ok = m["scrollWidth"] <= m["clientWidth"]
                        results.append({"screen": name, "width": width, "state": state, "ok": ok, **m})
                        mark = "ok  " if ok else "WIDE"
                        print(f"{mark} {name:<17} {width:>4}px  {state:<16} scrollWidth {m['scrollWidth']:>5}  window {m['clientWidth']}")
                        for o in [] if ok else m["offenders"]:
                            print(f"       {o}")
                    if args.shots:
                        page.screenshot(path=str(args.shots / f"{name}-{width}.png"), full_page=True)
                ctx.close()
            browser.close()
    finally:
        stop_server(server)
    if args.json:
        args.json.write_text(json.dumps(results, indent=2) + "\n")
    wide = [r for r in results if not r["ok"]]
    print(f"\n{len(results) - len(wide)} of {len(results)} pages fit their window" + (f"; {len(wide)} too wide" if wide else ""))
    return 1 if wide else 0


if __name__ == "__main__":
    sys.exit(main())
