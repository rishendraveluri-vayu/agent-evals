"""Tests for export_example.py: secrets are scrubbed, the check catches what survives, and an
export against a fake API writes a folder the API can load. No real API, no real model.

Run: python3 -m unittest discover -s scripts -p 'test_export_example.py'
"""

import base64
import gzip
import hashlib
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_example as ex  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
# A made-up key in LiteLLM's shape, planted to be caught. Not a real key.
PLANTED = "sk-PLANTEDtestkey1234567890abcdef"


def sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


class ScrubTest(unittest.TestCase):
    def test_scrubs_keys_bearer_tokens_secret_fields_and_known_values(self):
        s = ex.Scrubber({"my-real-master-key-value"})
        rows = {
            "trials": [
                {
                    "id": "t_1",
                    "agent_key_token": "abc123hashedtoken",
                    "runner_report": {
                        "note": f"called with {PLANTED} once",
                        "headers": {"Authorization": "Bearer abcdefghijklmnop"},
                        "log": "proxy said: Bearer qrstuvwxyz123456 was refused",
                        "env": "LITELLM_MASTER_KEY=my-real-master-key-value",
                        "api_key_env": "EVALS_MODEL_API_KEY",
                        "input_tokens": 12,
                    },
                }
            ]
        }
        clean = s.value(rows)
        report = clean["trials"][0]["runner_report"]
        self.assertIsNone(clean["trials"][0]["agent_key_token"])
        self.assertIsNone(report["headers"]["Authorization"])
        self.assertNotIn(PLANTED, json.dumps(clean))
        self.assertIn("Bearer [scrubbed]", report["log"])
        self.assertNotIn("my-real-master-key-value", report["env"])
        # A variable's name and a token count are not secrets.
        self.assertEqual(report["api_key_env"], "EVALS_MODEL_API_KEY")
        self.assertEqual(report["input_tokens"], 12)
        self.assertEqual(ex.find_secrets(clean, [], {"my-real-master-key-value"}), [])

    def test_a_clean_file_keeps_its_exact_bytes(self):
        data = b'{"b": 1,   "a": "plain"}\n'
        self.assertIs(ex.Scrubber(set()).file("result.json", data), data)

    def test_a_json_file_with_a_key_is_rewritten_without_it(self):
        data = json.dumps({"request": {"api_key": PLANTED, "model": "m"}}).encode()
        out = ex.Scrubber(set()).file("artifacts/proxy/0001.request.json", data)
        self.assertNotIn(PLANTED.encode(), out)
        self.assertEqual(json.loads(out)["request"], {"api_key": None, "model": "m"})

    def test_jsonl_lines_are_scrubbed_one_by_one(self):
        data = b'{"a": 1}\n{"token": "secret-token-value"}\nnot json ' + PLANTED.encode() + b"\n"
        out = ex.Scrubber(set()).file("trace.jsonl", data).decode()
        lines = out.split("\n")
        self.assertEqual(lines[0], '{"a": 1}')
        self.assertEqual(json.loads(lines[1]), {"token": None})
        self.assertNotIn(PLANTED, lines[2])

    def test_secret_values_come_from_env_and_dotenv_by_name(self):
        with tempfile.TemporaryDirectory() as d:
            dotenv = Path(d) / ".env"
            dotenv.write_text(
                "ANTHROPIC_API_KEY=anthropic-value-1\n# GEMINI_API_KEY=commented\n"
                "export EVALS_WORKER_TOKEN='worker-value-2'\nUI_PORT=8080\nSHORT_KEY=abc\n"
            )
            found = ex.secret_values({"POSTGRES_PASSWORD": "pg-value-3", "HOME": "/home/x"}, dotenv)
        self.assertTrue({"anthropic-value-1", "worker-value-2", "pg-value-3"} <= found)
        self.assertTrue(set(ex.DEFAULT_SECRETS) <= found)
        self.assertFalse({"8080", "/home/x", "abc", "commented"} & found)


class CheckTest(unittest.TestCase):
    """The check reads what would be written, independently of the scrub."""

    def test_a_planted_key_in_a_row_is_caught_and_located(self):
        tables = {"trials": [{"id": "t_1", "result": {"final": f"use {PLANTED}"}}]}
        problems = ex.find_secrets(tables, [], set())
        self.assertEqual(len(problems), 1)
        self.assertIn("trials[0].result.final", problems[0])
        self.assertNotIn(PLANTED, problems[0])  # the report never prints the key itself

    def test_a_secret_field_with_a_value_is_caught(self):
        problems = ex.find_secrets({"trials": [{"sim_key_token": "abcdef123"}]}, [], set())
        self.assertEqual(problems, ["trials[0].sim_key_token: a secret field with a value"])

    def test_keys_in_files_are_caught_in_text_json_and_binary(self):
        files = [
            {"trial_id": "t_1", "path": "stdout.log", "data": f"key={PLANTED}".encode()},
            {"trial_id": "t_1", "path": "result.json", "data": b'{"Authorization": "x-123"}'},
            {"trial_id": "t_1", "path": "blob.bin", "data": b"\xff\xfe" + PLANTED.encode()},
            {"trial_id": "t_1", "path": "env.txt", "data": b"wt-local-dev-only"},
        ]
        problems = ex.find_secrets({}, files, set(ex.DEFAULT_SECRETS))
        where = " | ".join(problems)
        for path in ("stdout.log", "result.json", "blob.bin", "env.txt"):
            self.assertIn(path, where)

    def test_scrubbed_markers_and_ordinary_text_pass(self):
        tables = {"spans": [{"raw": {"attributes": [{"key": "evals.cost_usd"}]}}]}
        files = [{"trial_id": "t", "path": "x.log", "data": b"sk-[scrubbed] and the word skill"}]
        self.assertEqual(ex.find_secrets(tables, files, set()), [])


class ToolsetHashTest(unittest.TestCase):
    def test_a_names_only_toolset_rebuilds_to_the_hash_the_api_gave_it(self):
        # The finance toolset as stored before 4 Nov (apps/api, commit 7c10900): its hash is the
        # canonical JSON of {id, version, servers}, computed by the API in TypeScript.
        tools = [
            "calculate_emi",
            "amortization_schedule",
            "prepayment_impact",
            "debt_payoff_plan",
            "sip_future_value",
            "fd_maturity",
            "inflation_adjusted_value",
            "loan_affordability",
            "get_client_profile",
            "list_debts",
            "list_transactions",
        ]
        known = "sha256:e8a330311211deaff01d3d7574752e6b852de20196872f9c340619af5e5453bb"
        spec = {
            "tools": {
                "toolset": {"id": "finance", "version": "all", "sha256": known[7:]},
                "mcp_servers": [{"name": "finance", "allowed_tools": tools, "command": ["x"]}],
            }
        }
        rebuilt = ex.toolset_from_specs(known, [{"spec": spec}])
        self.assertEqual(rebuilt["servers"], [{"name": "finance", "allowed_tools": tools}])
        self.assertIsNone(ex.toolset_from_specs("sha256:" + "0" * 64, [{"spec": spec}]))


# ---- an export against a fake API ----

EXP = "e_test0001"
TRIAL = "t_test0001"
CONFIG = "sha256:" + "c" * 64
TASK = "sha256:" + "a" * 64
PROMPT = "sha256:" + "b" * 64
TOOLSET = "sha256:" + "d" * 64
RESULT = json.dumps({"final_answer": "EMI is 8,997"}).encode()
REQUEST = json.dumps({"messages": [], "metadata": {"user_api_key": PLANTED}}).encode()


def fake_bundle(files):
    return {
        "format": "agent-evals-bundle",
        "format_version": 1,
        "schema_version": "011_examples",
        "experiment_id": EXP,
        "tables": {
            "prompts": [{"sha256": PROMPT, "id": "p", "version": "v1", "text": "t", "path": "x"}],
            "toolsets": [{"sha256": TOOLSET, "id": "finance", "version": "all", "servers": []}],
            "tasks": [{"sha256": TASK, "id": "task-1", "body": {}}],
            "configs": [
                {
                    "hash": CONFIG,
                    "name": "cfg",
                    "harness": "ownloop",
                    "model": "m",
                    "prompt_sha256": PROMPT,
                    "toolset_sha256": TOOLSET,
                    "parent_hash": None,
                }
            ],
            "experiments": [
                {
                    "id": EXP,
                    "name": "test experiment",
                    "axis": "harness",
                    "status": "done",
                    "n": 1,
                    "config_hashes": [CONFIG],
                    "task_sha256s": [TASK],
                    "created_at": "2026-11-04T10:00:00Z",
                    "parent_experiment_id": None,
                }
            ],
            "experiment_arms": [
                {"experiment_id": EXP, "config_hash": CONFIG, "arm": "A", "position": 0}
            ],
            "experiment_events": [],
            "trials": [
                {
                    "id": TRIAL,
                    "experiment_id": EXP,
                    "status": "done",
                    "task_sha256": TASK,
                    "config_hash": CONFIG,
                    "cost_usd": 0.01,
                    "folder": f"{EXP}/{TRIAL}/attempt-1",
                    "files": files,
                    "runner_report": {"files": [dict(f) for f in files]},
                }
            ],
            "spans": [{"trial_id": TRIAL, "raw": {"spanId": "s1", "name": "chat m"}}],
            "grading_jobs": [],
            "grades": [],
        },
    }


class FakeApi:
    def __init__(self, file_bodies: dict[str, bytes]):
        listed = [{"path": p, "bytes": len(b), "sha256": sha(b)} for p, b in file_bodies.items()]
        routes = {
            f"/api/experiments/{EXP}": json.dumps(
                {"status": "done", "counts": {"queued": 0, "running": 0}}
            ).encode(),
            f"/api/experiments/{EXP}/bundle": json.dumps(fake_bundle(listed)).encode(),
        }
        for p, b in file_bodies.items():
            routes[f"/api/trials/{TRIAL}/files/{p}"] = b

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                body = routes.get(self.path)
                self.send_response(200 if body is not None else 404)
                self.end_headers()
                self.wfile.write(body if body is not None else b'{"error": "not_found"}')

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ExportTest(unittest.TestCase):
    def run_export(self, file_bodies, out: Path):
        api = FakeApi(file_bodies)
        try:
            argv = [EXP, "--name", "test-example", "--title", "A test example", "--api", api.url]
            return ex.main([*argv, "--out", str(out), "--repo", str(out), "--source", "bundle"])
        finally:
            api.close()

    def test_an_export_scrubs_a_planted_key_and_writes_a_loadable_folder(self):
        bodies = {"result.json": RESULT, "artifacts/proxy/0001.request.json": REQUEST}
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            self.assertEqual(self.run_export(bodies, out), 0)
            folder = out / "test-example"
            manifest = json.loads((folder / "manifest.json").read_text())
            rows_gz = (folder / ex.ROWS_PART).read_bytes()
            files_gz = (folder / ex.FILES_PART).read_bytes()
            everything = gzip.decompress(rows_gz) + gzip.decompress(files_gz)
            self.assertNotIn(PLANTED.encode(), everything)
            self.assertEqual(manifest["parts"][ex.ROWS_PART]["sha256"], sha(rows_gz))
            self.assertEqual(manifest["parts"][ex.FILES_PART]["sha256"], sha(files_gz))
            self.assertEqual(manifest["counts"]["trials"], 1)
            self.assertEqual(manifest["counts"]["files"], 2)
            self.assertEqual(
                manifest["scrubbed"]["files"], [f"{TRIAL}/artifacts/proxy/0001.request.json"]
            )
            self.assertTrue(manifest["sample"])
            # The scrubbed file's new hash is what the trial lists, so the load's check holds.
            rows = json.loads(gzip.decompress(rows_gz))["tables"]
            lines = [json.loads(x) for x in gzip.decompress(files_gz).decode().splitlines()]
            listed = {f["path"]: f["sha256"] for f in rows["trials"][0]["files"]}
            for line in lines:
                self.assertEqual(listed[line["path"]], line["sha256"])
            self.assertEqual(
                next(x for x in lines if x["path"] == "result.json")["content"], RESULT.decode()
            )

    def test_a_key_the_scrub_cannot_remove_fails_the_export_and_writes_nothing(self):
        bodies = {"result.json": RESULT, "core.bin": b"\xff\xfe\x00" + PLANTED.encode()}
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.run_export(bodies, Path(d)), 1)
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_an_existing_example_is_not_replaced_without_replace(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "test-example").mkdir()
            self.assertEqual(self.run_export({"result.json": RESULT}, Path(d)), 1)


class ShippedExamplesTest(unittest.TestCase):
    def test_every_shipped_example_passes_the_secret_check(self):
        folders = sorted(p.parent for p in (REPO / "examples").glob("*/manifest.json"))
        for folder in folders:
            with self.subTest(example=folder.name):
                manifest = json.loads((folder / "manifest.json").read_text())
                rows_gz = (folder / ex.ROWS_PART).read_bytes()
                files_gz = (folder / ex.FILES_PART).read_bytes()
                self.assertEqual(manifest["parts"][ex.ROWS_PART]["sha256"], sha(rows_gz))
                self.assertEqual(manifest["parts"][ex.FILES_PART]["sha256"], sha(files_gz))
                tables = json.loads(gzip.decompress(rows_gz))["tables"]
                files = []
                for line in gzip.decompress(files_gz).decode().splitlines():
                    f = json.loads(line)
                    data = (
                        f["content"].encode()
                        if f["encoding"] == "utf8"
                        else base64.b64decode(f["content"])
                    )
                    files.append({"trial_id": f["trial_id"], "path": f["path"], "data": data})
                self.assertEqual(ex.find_secrets(tables, files, set(ex.DEFAULT_SECRETS)), [])
                self.assertTrue(manifest["sample"])


if __name__ == "__main__":
    unittest.main()
