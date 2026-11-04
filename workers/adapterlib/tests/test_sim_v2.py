"""D27: client-sim v2, the client summary and the optional simulator temperature, with the fake
simulator (SimServer) and the scripted adapter. No model is called."""

from __future__ import annotations

import copy
import hashlib
import json

from support import REPO, SimServer, attrs, client_sim, errors, make_spec, sha
from test_trial import by_name, run

from evals_adapter.gate import prompt_text
from evals_adapter.sim import CACHE_VERSION, END_MARKER, NO_CLIENT_FILE, cache_key, render_prompt

PROMPTS = REPO / "configs" / "prompts"
V1 = prompt_text(PROMPTS / "client-sim.v1.md")
V2 = prompt_text(PROMPTS / "client-sim.v2.md")
SUMMARY = (
    "Profile:\n- name: Meera Raghavan\n- monthly net income: 92500\n"
    "Debts (1, total balance ₹84,250.00, total minimum payments ₹4,212.50 a month):\n"
    "- Credit card: balance ₹84,250.00 at 42% a year, minimum payment ₹4,212.50 a month"
)


def v2_sim(url: str, summary: str | None = SUMMARY, temperature: float | None = None) -> dict:
    sim = client_sim(url, max_turns=3)
    if summary is not None:
        sim["client_summary"] = summary
    sim["model"]["temperature"] = temperature
    sim["model"]["prompt"] = {"id": "client-sim", "version": "v2", "sha256": sha(V2), "text": V2}
    return sim


def conversation_spec(sim: dict) -> dict:
    turns = [{"reply": "{{last_user}}", "model_calls": 1}]
    spec = make_spec(**{"harness_options.turns": turns, "task.client_sim": sim})
    spec["task"]["messages"] = [{"role": "user", "content": "I don't know where to start."}]
    return spec


def test_v2_fills_every_placeholder_and_keeps_the_v1_guards():
    sim = v2_sim("http://unused/v1")
    text = render_prompt(V2, sim)
    assert "{{" not in text and "}}" not in text
    assert SUMMARY in text
    assert "Meera, 41, Pune" in text and "Take-home Rs 92,000 a month" in text
    assert text.count(END_MARKER) == 2
    # v1's yes-man guards, word for word.
    for guard in [
        "Do not suddenly become calm, grateful or upbeat because the advisor was polite.",
        "push back: say it does not fit your situation and repeat what worries you.",
        "Never praise advice that has not answered your concerns.",
        "refuse and say it makes you uneasy.",
        "Do not invent new problems, numbers or facts beyond what is written above.",
    ]:
        assert guard in V1 and guard in text, guard
    # The D27 rules.
    assert "Never deny or contradict it." in text
    assert "No narration and no stage directions." in text
    assert '"*sighs*"' in text
    assert "End the conversation as soon as your concerns have been answered" in text


def test_v2_without_a_client_file_says_so_and_v1_ignores_the_summary():
    assert NO_CLIENT_FILE in render_prompt(V2, v2_sim("http://unused/v1", summary=None))
    with_summary = render_prompt(V1, v2_sim("http://unused/v1"))
    without = render_prompt(V1, v2_sim("http://unused/v1", summary=None))
    assert with_summary == without and SUMMARY not in with_summary


def test_the_summary_reaches_the_simulator_prompt_and_a_null_temperature_is_not_sent(tmp_path):
    sim = SimServer(["Will I lose the house?", "Thank you, that is clear. [[END_CONVERSATION]]"])
    try:
        spec = conversation_spec(v2_sim(sim.url, temperature=None))
        assert errors("spec", spec) == []
        report, result, spans = run(tmp_path, spec, env={"EVALS_SIM_API_KEY": "sk-sim"})
    finally:
        sim.close()
    assert report["label"] == "agent", report
    assert errors("result", result) == []
    assert sim.requests, "the simulator was never called"
    for req in sim.requests:
        system = req["body"]["messages"][0]
        assert system["role"] == "system"
        assert SUMMARY in system["content"]
        assert "{{client_summary}}" not in system["content"]
        assert "temperature" not in req["body"], req["body"]
        assert req["body"]["max_tokens"] == 300
    # The end marker still ends the conversation, before the turn cap of 3.
    conv = result["conversation"]
    assert conv["ended_by"] == "client"
    assert conv["client_turns"] == 2 and conv["agent_turns"] == 2
    assert conv["transcript"][-1] == {
        "role": "user",
        "content": "Thank you, that is clear.",
        "source": "client_sim",
    }
    assert [attrs(s)["evals.sim.done"] for s in by_name(spans, "client_sim.turn")] == [False, True]


def test_an_absent_temperature_is_also_not_sent(tmp_path):
    sim = SimServer([f"Thanks. {END_MARKER}"])
    try:
        sim_block = v2_sim(sim.url)
        del sim_block["model"]["temperature"]
        spec = conversation_spec(sim_block)
        assert errors("spec", spec) == []
        _, result, _ = run(tmp_path, spec, env={"EVALS_SIM_API_KEY": "sk-sim"})
    finally:
        sim.close()
    assert result["conversation"]["ended_by"] == "client"
    assert all("temperature" not in r["body"] for r in sim.requests)


def test_a_set_temperature_is_still_sent(tmp_path):
    sim = SimServer([f"Thanks. {END_MARKER}"])
    try:
        _, result, _ = run(
            tmp_path,
            conversation_spec(v2_sim(sim.url, temperature=0)),
            env={"EVALS_SIM_API_KEY": "sk-sim"},
        )
    finally:
        sim.close()
    assert result["conversation"]["ended_by"] == "client"
    assert [r["body"]["temperature"] for r in sim.requests] == [0]


def test_the_cache_key_covers_the_summary_and_a_null_temperature():
    transcript = [{"role": "user", "content": "I don't know where to start."}]
    spec = conversation_spec(v2_sim("http://unused/v1", temperature=None))
    base = cache_key(spec, transcript)
    other_summary = copy.deepcopy(spec)
    other_summary["task"]["client_sim"]["client_summary"] = SUMMARY + "\n- one more debt"
    at_zero = copy.deepcopy(spec)
    at_zero["task"]["client_sim"]["model"]["temperature"] = 0
    assert len({base, cache_key(other_summary, transcript), cache_key(at_zero, transcript)}) == 3


def test_a_spec_without_a_summary_keeps_its_pre_d27_cache_key():
    """Replies stored before D27 (no client_summary, temperature 0) are still found."""
    transcript = [{"role": "user", "content": "I don't know where to start."}]
    spec = conversation_spec(v2_sim("http://unused/v1", summary=None, temperature=0))
    model = spec["task"]["client_sim"]["model"]
    old_material = {
        "v": CACHE_VERSION,
        "task_id": spec["trial"]["task_id"],
        "task_version": spec["trial"]["task_version"],
        "sim_model": model["name"],
        "temperature": model["temperature"],
        "max_output_tokens": model["max_output_tokens"],
        "prompt_sha256": model["prompt"]["sha256"],
        "transcript": transcript,
    }
    blob = json.dumps(old_material, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    assert cache_key(spec, transcript) == "sha256:" + hashlib.sha256(blob.encode()).hexdigest()
