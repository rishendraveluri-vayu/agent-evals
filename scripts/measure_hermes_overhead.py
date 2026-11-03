"""Estimate Hermes per-call prompt overhead without any LLM call.

Usage: python measure_hermes_overhead.py <empty_hermes_home> <output_system_prompt.txt>
Run with Python 3.14 and Hermes installed at the pinned SHA. Sizes are chars / 4 estimates.
"""
import json, os, sys, logging
logging.disable(logging.CRITICAL)
os.environ["HERMES_HOME"]=sys.argv[1]
def toks(s): return len(s)//4
from run_agent import AIAgent
def run(name, ts, **kw):
    a=AIAgent(base_url="http://127.0.0.1:9/v1", api_key="x", model="test-model", enabled_toolsets=ts, quiet_mode=True, max_iterations=5, skip_context_files=True, session_db=None, **kw)
    tools=a.tools or []
    sp=None
    for fn in ("_build_system_prompt",):
        f=getattr(a,fn,None)
        if f:
            try: sp=f()
            except Exception as e: sp=f"ERR {e}"
    tj=json.dumps(tools)
    print(f"{name}: tools={len(tools)} tool_schema_chars={len(tj)} (~{toks(tj)} tok) sys_chars={len(sp or '')} (~{toks(sp or '')} tok)  mode={a.api_mode} names={[t['function']['name'] for t in tools][:14]}")
    return sp
sp=run("default(all)", None)
run("min file+terminal", ["file","terminal"])
run("file+terminal+memory+skills", ["file","terminal","memory","skills"])
run("file+terminal skip_memory", ["file","terminal"], skip_memory=True)
open(sys.argv[2],"w").write(sp or "")
