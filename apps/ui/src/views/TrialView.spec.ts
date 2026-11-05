import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import judge from '../fixtures/judge-agreement.json';
import queue from '../fixtures/label-queue.json';
import prompts from '../fixtures/prompts.json';
import trialSpans from '../fixtures/trial-spans.json';
import trial from '../fixtures/trial.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import TrialView from './TrialView.vue';

describe('TrialView in fixture mode', () => {
  useFixtures();

  it('leads with the arm, the trial and the outcome in words', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="trial-title"]').text()).toBe('Arm B, trial 3 of 5');
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed 1 of 3 checks');
    const facts = w.get('[data-test="trial-facts"]').text();
    expect(facts).toContain('Agent answered');
    // Beside the call counts: the simulated client's model, which shapes the conversation too.
    expect(facts).toContain('Hermes counted 3; client Claude Haiku 5.5');
    expect(facts).toContain('5.4 s of it start-up');
    expect(facts).toContain('$0.18');
    expect(facts).toContain('3 agent, 1 client');
    expect(facts).toContain('19,240');
  });

  it('says a trial that does not exist is not found, under a breadcrumb, with a way out', async () => {
    const w = mount(TrialView, { props: { trialId: 't_nope' } });
    await settle();
    expect(w.find('[data-test="load-error"]').exists()).toBe(false);
    const page = w.get('[data-test="not-found"]');
    expect(page.get('nav').text()).toBe('Experiments / Not found');
    expect(page.get('h1').text()).toBe('No trial with that id');
    expect(page.text()).toContain('Nothing is saved as t_nope');
    expect(page.findAll('a').map((a) => a.attributes('href'))).toEqual(['#/experiments', '#/experiments', '#/trials']);
  });

  it('puts the tool calls before the reply and marks what the failed check quoted', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const names = w.findAll('[data-test="tool-call"] summary .mono').map((n) => n.text());
    expect(names).toEqual(['get_client_profile', 'fd_maturity', 'sip_future_value']);
    const messages = w.findAll('[data-test="message"]');
    expect(messages.map((m) => m.find('.bubble-who').text())).toEqual(['Client', 'Agent']);
    expect(messages[1].get('mark').text()).toBe('an FD is the safer choice. ₹5 lakh at 7.1% grows to about ₹7,10,870');
    // The highlight links to the check that quoted it, and says so to a screen reader.
    const quote = messages[1].get('[data-test="quote-link"]');
    expect(quote.attributes('href')).toBe('#grade-1');
    expect(quote.get('.visually-hidden').text()).toBe('Quoted by the judge for fd-tax:');
    expect(w.get('[data-test="mark-key"]').text()).toBe('Highlighted: text the judge quoted for a failed check.');
    expect(w.findAll('[data-test="mark-key"]')).toHaveLength(1);
    const grades = w.findAll('[data-test="grade"]');
    expect(grades).toHaveLength(3);
    expect(grades[1].text()).toContain('fd-tax');
    expect(grades[1].text()).toContain('Fail');
    expect(grades[1].get('[data-test="grade-kind"]').text()).toBe('Judge claude-haiku-5-5, rubric 5123602');
    expect(grades[1].get('[data-test="grade-kind"] .mono').text()).toBe('claude-haiku-5-5');
    expect(grades[0].get('[data-test="grade-kind"]').text()).toBe('Exact match, number');
    const at = w.findAll('[data-test="tool-call"] .at');
    expect(at[0].text()).toMatch(/^at \d+\.\d s$/);
    expect(at[0].attributes('title')).toMatch(/^Started \d+\.\d s in, took \d+\.\d s$/);
  });

  it("lists this task's other trials in this arm, each with how it ended, as links", async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const strip = w.get('[data-test="same-cell"]');
    expect(strip.attributes('aria-label')).toBe('Trials of fd-vs-sip-07 in arm B');
    expect(strip.text()).toMatch(/^Arm B on fd-vs-sip-07:/);
    const items = strip.findAll('li');
    expect(items.length).toBeGreaterThan(1);
    // This trial is named, not linked; the others link to their own pages.
    const current = strip.get('[aria-current="page"]');
    expect(current.text()).toBe('Trial 3');
    const links = strip.findAll('a').map((a) => a.attributes('href'));
    expect(links.every((h) => h?.startsWith('#/trials/tr_fd-vs-sip-07_b_'))).toBe(true);
    expect(links).not.toContain('#/trials/tr_fd-vs-sip-07_b_3');
    for (const li of items) expect(li.text()).toMatch(/(passed|failed|infra failure|not graded|running|not run yet|cancelled)$/);
  });

  it('names the pinned harness and says which check failed and who graded it', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="trial-meta"]').text()).toBe('Prompt v2, config 7f3a9c2, Hermes 6112c2a');
    const failedOn = w.get('[data-test="failed-on"]');
    expect(failedOn.get('a').attributes('href')).toBe('#grade-1');
    const grades = w.findAll('[data-test="grade"]');
    expect(grades[1].attributes('id')).toBe('grade-1');
    // The status pill still reports the grades as they are.
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed 1 of 3 checks');
  });

  it('keeps your held-out label out of sight while held-out outputs remain, on a task not in the queue', async () => {
    // fd-vs-sip-07 has no output in the queue, but your label on this trial disputes the judge.
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-tax (judge)');
    expect(w.find('[data-test="dispute"]').exists()).toBe(false);
    expect(w.text()).not.toContain('Your held-out label');
    expect(w.text()).not.toContain('your label');
    // Its quotes, rationale and highlight stay: none of its outputs is still to label.
    const grades = w.findAll('[data-test="grade"]');
    expect(grades[1].find('blockquote').exists()).toBe(true);
    expect(grades[1].text()).toContain('The profile shows a 30% slab');
    expect(w.find('[data-test="hidden-reasons"]').exists()).toBe(false);
    expect(w.find('mark').exists()).toBe(true);
    expect(w.find('[data-test="mark-key"]').exists()).toBe(true);
  });

  it('jumps to the failed check without changing the route, from "Failed on" or the highlight', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' }, attachTo: document.body });
    await settle();
    const before = window.location.hash;
    await w.get('[data-test="failed-on"] a').trigger('click');
    expect(document.activeElement?.id).toBe('grade-1');
    (document.activeElement as HTMLElement).blur();
    await w.get('[data-test="quote-link"]').trigger('click');
    expect(document.activeElement?.id).toBe('grade-1');
    expect(window.location.hash).toBe(before);
    w.unmount();
  });

  it('shows a chevron on every disclosure, after the time on tool rows', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="tool-call"]').classes()).toEqual(expect.arrayContaining(['disclosure', 'tool-call']));
    expect(w.get('.requests > summary').text()).toMatch(/^Model requests \(\d+\)$/);
  });

  it('places the timeline in the story column, under the conversation', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const story = w.get('.story');
    expect(story.find('#timeline').exists()).toBe(true);
    expect(story.find('#convo').exists()).toBe(true);
    expect(w.get('.grading').find('#timeline').exists()).toBe(false);
  });

  it('keeps the settings and files apart from the grading, so a phone can put the story between them', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const grading = w.get('.grading').element;
    const applied = w.get('.applied').element;
    expect(applied.parentElement).toBe(grading.parentElement);
    expect(grading.contains(applied)).toBe(false);
    expect(w.get('.grading').find('#graders').exists()).toBe(true);
    expect(w.get('.grading').findAll('[data-test="grade"]')).toHaveLength(3);
    expect(w.get('.applied').text()).toContain('Settings as applied');
    expect(w.get('.applied').find('[data-test="trial-files"]').exists()).toBe(true);
    expect(w.get('.applied').find('.requests').exists()).toBe(true);
    // The files have their own heading, and the model requests their own row.
    expect(w.get('[data-test="files-title"]').text()).toBe('Files');
    expect(w.get('[data-test="files-title"]').classes()).toContain('sub-title');
    expect(w.get('[data-test="files-title"]').element.nextElementSibling).toBe(w.get('[data-test="trial-files"]').element);
  });

  it('says prompt-cache markers change cost and time, not the reply', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const source = w.get('[data-test="applied-source-prompt_cache_markers"]');
    // D31: cache markers are off in every Hermes config, so the config sets it.
    expect(source.text()).toBe('Config Affects cost and time, not the reply.');
    expect(source.get('.setting-note').text()).toBe('Affects cost and time, not the reply.');
    expect(w.findAll('.setting-note')).toHaveLength(1);
  });

  it('wraps each summary\'s words in one block, with the time inside it, so only the words wrap', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    for (const summary of w.findAll('.story summary')) expect(summary.find('.summary-text').exists()).toBe(true);
    const at = w.find('[data-test="tool-call"] .summary-text .at');
    expect(at.exists()).toBe(true);
  });

  it('draws the timeline with the start-up and shut-down the harness spends around the agent', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.text()).toContain('Hermes start-up');
    expect(w.text()).toContain('Shut down and collect files');
    const rows = w.findAll('[data-test="span-row"]');
    expect(rows).toHaveLength(7);
    await rows[1].trigger('click');
    expect(w.get('[data-test="span-detail"]').text()).toContain('execute_tool get_client_profile');
  });

  it('says plainly when the sample data has no such trial, and which one it has', async () => {
    const w = mount(TrialView, { props: { trialId: 'nope' } });
    await settle();
    expect(w.get('[data-test="not-found"]').text()).toContain('No sample data for trial nope. The sample covers one trial in full');
  });
});

describe('TrialView against the API: blind labelling', () => {
  type Detail = { tasks: { id: string; sha256: string }[] };
  const heldout = (details as unknown as Record<string, Detail>).exp_heldout;
  /** The trial's task, as GET /trials/:id carries it: the task's id and sha256. */
  const sha = (id: string) => ({ id, sha256: heldout.tasks.find((t) => t.id === id)?.sha256 ?? '' });
  function routes(over: { trialId?: string; task?: { id: string; sha256: string }; queue?: unknown }) {
    const id = over.trialId ?? 'tr_fd-vs-sip-07_b_3';
    return routeFetch({
      [`/api/trials/${id}`]: { ...trial, id, task: over.task ? { ...trial.task, ...over.task } : trial.task },
      [`/api/trials/${id}/spans`]: trialSpans,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': over.queue ?? queue.heldout,
      '/api/experiments/exp_heldout': heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
  }

  it("hides the judge's reasons on a task with outputs still to label, keeping its verdicts", async () => {
    routes({ trialId: 'tr_distress-12_b_3', task: sha('distress-12') });
    const w = mount(TrialView, { props: { trialId: 'tr_distress-12_b_3' } });
    await settle();
    const grades = w.findAll('[data-test="grade"]');
    expect(grades).toHaveLength(3);
    for (const [g, rubric] of [[grades[1], '5123602'], [grades[2], '728a3f4']] as const) {
      // Title, Pass or Fail, and the judge's model and rubric stay; quotes and rationale go. The
      // rubric's version is a sha256, shown short.
      expect(g.get('[data-test="grade-kind"]').text()).toBe(`Judge claude-haiku-5-5, rubric ${rubric}`);
      expect(g.find('.pill').exists()).toBe(true);
      expect(g.find('blockquote').exists()).toBe(false);
      expect(g.get('[data-test="hidden-reasons"]').text()).toBe("The judge's reasons for this task are hidden while 1 of its held-out outputs is still to label.");
    }
    expect(grades[1].text()).toContain('fd-tax');
    expect(grades[1].get('.pill').text()).toBe('Fail');
    expect(grades[1].text()).not.toContain('The profile shows a 30% slab');
    // A code-graded check is unchanged.
    expect(grades[0].text()).toContain('found ₹7,10,870, within ±1 of 710870 (fd_maturity maturity_rupees)');
    expect(grades[0].find('[data-test="hidden-reasons"]').exists()).toBe(false);
    // No highlight in the transcript, and no key for one.
    expect(w.find('mark').exists()).toBe(false);
    expect(w.find('[data-test="quote-link"]').exists()).toBe(false);
    expect(w.find('[data-test="mark-key"]').exists()).toBe(false);
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-tax (judge)');
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed 1 of 3 checks');
  });

  it('counts the outputs still to label for the task', async () => {
    const two = [...queue.heldout, { ...queue.heldout[1], item_id: 'lq_extra' }];
    routes({ trialId: 'tr_distress-12_b_3', task: sha('distress-12'), queue: two });
    const w = mount(TrialView, { props: { trialId: 'tr_distress-12_b_3' } });
    await settle();
    expect(w.get('[data-test="hidden-reasons"]').text()).toBe("The judge's reasons for this task are hidden while 2 of its held-out outputs are still to label.");
  });

  it('brings back your label and where it disputes the judge once the held-out set is labelled', async () => {
    routes({ queue: [] });
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-tax (judge; your label passes it)');
    const grades = w.findAll('[data-test="grade"]');
    const dispute = grades[1].get('[data-test="dispute"]');
    expect(dispute.text()).toBe('Your held-out label: Yes. You and the judge disagree on this check. See judge agreement');
    expect(dispute.get('a').attributes('href')).toBe('#/labels/judge');
    expect(grades[2].find('[data-test="dispute"]').exists()).toBe(false);
    expect(w.find('mark').exists()).toBe(true);
    expect(w.find('[data-test="hidden-reasons"]').exists()).toBe(false);
  });
});

describe('TrialView against the API: the outcome in words, and the simulated client', () => {
  type Detail = Record<string, unknown> & { sim_model: string | null };
  const heldout = (details as unknown as Record<string, Detail>).exp_heldout;
  const grade = trial.grades[0];
  function mountWith(over: { grades?: unknown[]; simModel?: string | null }) {
    routeFetch({
      '/api/trials/tr_fd-vs-sip-07_b_3': { ...trial, grades: over.grades ?? trial.grades },
      '/api/trials/tr_fd-vs-sip-07_b_3/spans': trialSpans,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
      '/api/experiments/exp_heldout': { ...heldout, sim_model: over.simModel === undefined ? heldout.sim_model : over.simModel },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
    return mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
  }

  it('says "Passed all 3 checks", and "its one check" when there is one', async () => {
    const pass = { ...grade, verdict: 'pass' };
    let w = mountWith({ grades: [pass, { ...pass, grader_id: 'g2' }, { ...pass, grader_id: 'g3' }] });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Passed all 3 checks');
    w = mountWith({ grades: [pass] });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Passed its one check');
    w = mountWith({ grades: [{ ...grade, verdict: 'fail' }] });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed its one check');
  });

  it('leaves the client model out of the call counts when the experiment has none', async () => {
    const w = mountWith({ simModel: null });
    await settle();
    const facts = w.get('[data-test="trial-facts"]').text();
    expect(facts).toContain('Hermes counted 3');
    expect(facts).not.toContain('client Claude');
  });
});

describe('TrialView against the API: the failure cause (D64)', () => {
  const heldout = (details as Record<string, unknown>).exp_heldout;
  function mountWith(cause: unknown, labels: unknown = queue.heldout, over: Record<string, unknown> = {}) {
    routeFetch({
      '/api/trials/tr_fd-vs-sip-07_b_3': { ...trial, cause, ...over },
      '/api/trials/tr_fd-vs-sip-07_b_3/spans': trialSpans,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': labels,
      '/api/experiments/exp_heldout': heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
    return mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
  }

  it('says why it failed under the checks it failed, with the reason and every other cause that fits', async () => {
    const w = mountWith({
      cause: 'wrong_tool',
      reason: 'fd_maturity was never called; calculate_emi was',
      contributing: [{ cause: 'unsupported_figure', reason: '₹7,10,870 has no tool result, client-file number or message behind it (1 of 4 figures)' }],
      rules_version: 'causes-1',
    });
    await settle();
    const cause = w.get('[data-test="trial-cause"]');
    expect(cause.get('p').text()).toBe('Why it failed: Wrong tool. fd_maturity was never called; calculate_emi was.');
    expect(cause.get('[data-test="trial-cause-also"]').text()).toBe('Also figure with no source: ₹7,10,870 has no tool result, client-file number or message behind it (1 of 4 figures).');
    expect(inOrderOf(w, '[data-test="failed-on"]', '[data-test="trial-cause"]')).toBe(true);
  });

  it('keeps the judge against your label out of sight while held-out outputs remain, and names it once they are labelled', async () => {
    const judgeVsLabel = { cause: 'judge_vs_label', reason: 'On fd-tax the judge said no and the human label says yes', contributing: [], rules_version: 'causes-1' };
    let w = mountWith(judgeVsLabel);
    await settle();
    expect(w.get('[data-test="trial-cause"]').text()).toBe('Why it failed: A judge check failed. How it compares with the human labels is shown once the held-out outputs are labelled.');
    expect(w.text()).not.toContain('your label');
    w = mountWith(judgeVsLabel, []);
    await settle();
    expect(w.get('[data-test="trial-cause-name"]').text()).toBe('Judge disagrees with your label');
    expect(w.get('[data-test="trial-cause"]').text()).toContain('On fd-tax the judge said no and the human label says yes.');
  });

  it('says why a trial stopped short even when its checks passed, and shows nothing for a trial with no cause', async () => {
    const steps = { cause: 'ran_out_of_steps', reason: 'Stopped at the step limit after 17 model calls (its limit is 15); Hermes asks for a summary at the limit, and that summary is the answer that was graded', contributing: [], rules_version: 'causes-1' };
    let w = mountWith(steps, queue.heldout, { grades: trial.grades.map((g) => ({ ...g, verdict: 'pass' })), end_state: 'step_limit' });
    await settle();
    expect(w.get('[data-test="trial-cause"]').text()).toMatch(/^Why it stopped short: Ran out of steps\. Stopped at the step limit after 17 model calls/);
    w = mountWith(null);
    await settle();
    expect(w.find('[data-test="trial-cause"]').exists()).toBe(false);
  });
});

/** The second element comes after the first in the document. */
function inOrderOf(w: ReturnType<typeof mount>, first: string, second: string): boolean {
  return !!(w.get(first).element.compareDocumentPosition(w.get(second).element) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('TrialView against the folder-based endpoints', () => {
  it('still reads a gate run from GET /trials/:id and /spans in the folder store shape', async () => {
    const summary = {
      trialId: 'gate-1', harness: 'ownloop', model: 'fake/x', taskId: 'emi-basic-01', configHash: null, promptVersion: 'v1', toolsetVersion: '1',
      label: 'agent', endState: 'answered', startedAt: null, wallS: 0.8, proxyCalls: 2, proxyCostUsd: 0.0026, proxyInputTokens: 2410, proxyOutputTokens: 96,
      proxyComplete: true, harnessCalls: 2, toolCalls: 1, toolErrors: 0, malformedToolCalls: 0, agentTurns: 1, clientTurns: 0,
    };
    const span = (id: string, parent: string | null, name: string, start: number, end: number, attributes = {}) => ({
      spanId: id, parentSpanId: parent, name, kind: 1, startNs: String(start * 1_000_000), endNs: String(end * 1_000_000), statusCode: 1, statusMessage: null, attributes, events: [],
    });
    const { calls } = routeFetch({
      '/api/trials/gate-1': {
        summary,
        spec: null,
        result: { conversation: { transcript: [{ role: 'user', content: 'EMI?', source: 'task' }, { role: 'assistant', content: 'Rs 8,997.26.', source: 'agent' }] }, counts: { model_calls: 2 } },
        report: null,
      },
      '/api/trials/gate-1/spans': [
        span('a', null, 'invoke_agent ownloop', 0, 800),
        span('b', 'a', 'agent.turn', 10, 700),
        span('c', 'b', 'chat fake/x', 20, 100, { 'evals.role': 'agent' }),
        span('d', 'b', 'execute_tool calculate_emi', 110, 120, { 'gen_ai.tool.name': 'calculate_emi', 'evals.tool.arguments': '{"principal": 1000000}', 'evals.tool.result': '{"emi": "8997.26"}' }),
      ],
    });
    const w = mount(TrialView, { props: { trialId: 'gate-1' } });
    await settle();
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(['/api/trials/gate-1', '/api/trials/gate-1/spans']));
    expect(w.get('[data-test="trial-title"]').text()).toBe('Own loop on emi-basic-01');
    expect(w.findAll('[data-test="message"]')).toHaveLength(2);
    expect(w.get('[data-test="tool-call"]').text()).toContain('calculate_emi');
    expect(w.get('[data-test="trial-files"] a').attributes('href')).toBe('/api/trials/gate-1/files/result.json');
  });
});

describe('TrialView against the API: memory and skills (brief item 6)', () => {
  type Detail = Record<string, unknown>;
  const heldout = (details as unknown as Record<string, Detail>).exp_heldout;
  const on = { value: { enabled: true }, source: 'config' };
  const ev = (name: string, at: string, attrs: Record<string, string>) => ({
    name,
    timeUnixNano: at,
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })),
  });
  function mountWith(memorySkillsOn: boolean, events: unknown[]) {
    const [root, ...rest] = trialSpans as unknown as Record<string, unknown>[];
    const applied = { ...trial.result.applied_settings, ...(memorySkillsOn ? { memory: on, skills: on } : {}) };
    routeFetch({
      '/api/trials/tr_fd-vs-sip-07_b_3': { ...trial, result: { ...trial.result, applied_settings: applied } },
      '/api/trials/tr_fd-vs-sip-07_b_3/spans': [{ ...root, events }, ...rest],
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
      '/api/experiments/exp_heldout': heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
    return mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
  }

  it('lists what was read from memory, written to it and which skills were loaded, in time order', async () => {
    const w = mountWith(true, [
      ev('evals.skill.load', '1793878280000000000', { 'evals.skill.name': 'emi-playbook' }),
      ev('evals.memory.read', '1793878273000000000', { 'evals.memory.target': 'memory', 'evals.memory.entries': '2', 'evals.memory.content': 'Salary on the 1st.\n§\nNo new loans.' }),
      ev('evals.memory.write', '1793878290000000000', { 'evals.memory.target': 'user', 'evals.memory.action': 'add', 'evals.memory.content': 'Prefers EMIs under Rs 20,000.' }),
      ev('evals.compression', '1793878291000000000', {}),
    ]);
    await settle();
    const items = w.get('[data-test="memory-skills"]').findAll('li');
    expect(items.map((i) => i.get('.memory-skills__title').text())).toEqual([
      'Memory read into the prompt at the start: 2 entries',
      'Skill loaded: emi-playbook',
      'Memory written (user profile): add',
    ]);
    expect(items[0].get('.memory-skills__detail').text()).toBe('Salary on the 1st.\n§\nNo new loans.');
    expect(w.text()).toContain('Memory events: 2. Skill events: 1. They are listed under Memory and skills.');
  });

  it('says so when memory or skills were on but nothing was read, written or loaded', async () => {
    const w = mountWith(true, []);
    await settle();
    expect(w.get('[data-test="memory-skills"]').text()).toContain('Memory or skills were on, but the agent read no memory and loaded or wrote no skill.');
  });

  it('shows no such section when both are off', async () => {
    const w = mountWith(false, []);
    await settle();
    expect(w.find('[data-test="memory-skills"]').exists()).toBe(false);
    expect(w.text()).toContain('No memory was read or written and no skills were loaded: both are off in this config.');
  });
});
