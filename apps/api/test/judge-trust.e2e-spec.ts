import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import type { CompareResponse, GraderClaimResponse, JudgeTrust, JudgeTrustResponse } from '../src/contract';
import { graderVersion } from '../src/grading/grading-core';
import { REPO, type TestEnv, auth, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';

/**
 * D83 on the real API and Postgres: GET /judge/trust and the
 * comparison's `stats.judge`. LiteLLM is stubbed, the agent's report and the judge's grades are
 * played by the test (no model is called), and every label is SYNTHETIC, written into this test's
 * own temporary labels folder, never the repo's labels/.
 */

jest.setTimeout(90_000);

const EXAMPLE_RESULT = JSON.parse(readFileSync(path.join(REPO, 'contract/v2/examples/result.json'), 'utf8')) as Record<string, unknown>;
const RUBRIC = 'configs/rubrics/advice.v4.md';
const GRADER_FRAMEWORK = 'test-grader-0';

/** Synthetic tasks for this file only: a required end-state check and an optional judge with two criteria. */
const TRUST_TASKS: Record<string, 'held_out' | 'discovery'> = { 'trust-held-1': 'held_out', 'trust-held-2': 'held_out', 'trust-tune': 'discovery' };

type Verdicts = Record<string, string> | null;

interface Ran {
  id: string;
  arm: 'A' | 'B';
  repeat: number;
  task: string;
}

describeWithDb('judge trust (D83, e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;
  let e: ReturnType<typeof engine>;
  let A: string;
  let B: string;
  let clock = Date.parse('2026-11-06T09:00:00.000Z');

  beforeAll(async () => {
    env = await bootEnv();
    for (const [id, split] of Object.entries(TRUST_TASKS)) {
      await fs.mkdir(path.join(env.tasksDir, id), { recursive: true });
      const task = {
        id,
        version: '1',
        split,
        summary: `Synthetic judge-trust task ${id} (test fixture)`,
        messages: [{ role: 'user', content: `Question ${id}` }],
        client_sim: null,
        graders: [
          { id: 'answered', type: 'end_state', states: ['answered'] },
          {
            id: 'overall',
            type: 'judge',
            required: false,
            rubric: RUBRIC,
            criteria: [
              { id: 'overall', text: 'Would a real client in this situation be well served by this?' },
              { id: 'plain', text: 'Does it explain each figure in plain words?' },
            ],
          },
        ],
      };
      await fs.writeFile(path.join(env.tasksDir, id, 'task.json'), JSON.stringify(task, null, 2));
    }
    cat = await catalogue(env.http);
    // Real model names, so the label queue takes their trials (a fake model's are left out); LiteLLM is stubbed.
    A = await makeConfig(env.http, cat, { name: 'trust arm A', model: 'claude-haiku-5-5', settings: { max_steps: 10 } });
    B = await makeConfig(env.http, cat, { name: 'trust arm B', model: 'claude-haiku-5-5', settings: { max_steps: 12 } });
    e = engine(env);
  });

  afterAll(async () => {
    await env.close();
  });

  beforeEach(async () => {
    await e.quiesce();
  });

  /** Creates and runs an experiment: every trial claimed and reported as an agent answer. */
  async function run(configs: string[], tasks: string[], n: number): Promise<{ id: string; trials: Ran[] }> {
    const exp = await e.experiment({ config_hashes: configs, task_sha256s: tasks.map((t) => cat.tasks[t]), n, futility: { enabled: false } });
    const trials: Ran[] = [];
    for (let c = await e.claim('w-trust'); c; c = await e.claim('w-trust')) {
      const spec = c.spec as { trial: { config_hash: string; repeat_index: number; task_id: string } };
      trials.push({ id: c.trial_id, arm: spec.trial.config_hash === configs[0] ? 'A' : 'B', repeat: spec.trial.repeat_index, task: spec.trial.task_id });
      await e.report(c, 'w-trust', 'agent', { result: { ...EXAMPLE_RESULT, trial_id: c.trial_id } });
    }
    expect(trials).toHaveLength(configs.length * tasks.length * n);
    return { id: exp.id, trials };
  }

  /**
   * Grades every waiting job as the grader worker would: the end-state check passes; the judge
   * calls `model` and answers each criterion as `verdicts` says (null: the call failed, no criterion).
   */
  async function judge(model: string, verdicts: (trialId: string) => Verdicts): Promise<number> {
    let graded = 0;
    for (;;) {
      const res = await request(env.http).post('/api/grader/claim').set(auth).send({ worker_id: 'g-trust' });
      if (res.status === 204) return graded;
      expect(res.status).toBe(200);
      const job = res.body as GraderClaimResponse;
      const v = verdicts(job.trial_id);
      const grades = job.graders.map((g) => {
        const spec = g.spec as { id: string; type: string; required?: boolean };
        const version = graderVersion(g.spec_sha256, GRADER_FRAMEWORK);
        if (spec.type !== 'judge') return { grader_id: spec.id, type: spec.type, required: true, verdict: 'pass', score: 1, reason: 'answered', evidence: [], grader_version: version };
        const items = Object.entries(v ?? {}).map(([criterion, verdict]) => ({ criterion, required: true, verdict, quote: `quote for ${criterion}`, reason: `judge says ${verdict} on ${criterion}`, source: 'judge', quote_found: false }));
        const word = !v ? 'error' : items.some((i) => i.verdict === 'no') ? 'fail' : items.every((i) => i.verdict === 'yes') ? 'pass' : 'error';
        return {
          grader_id: spec.id,
          type: 'judge',
          required: spec.required ?? true,
          verdict: word,
          score: word === 'pass' ? 1 : word === 'fail' ? 0 : null,
          reason: `judge: ${word}`,
          evidence: [...items, { source: 'judge_call', model, input_tokens: 10, output_tokens: 5 }],
          grader_version: version,
        };
      });
      const out = await request(env.http)
        .post(`/api/grader/trials/${job.trial_id}/grades`)
        .set(auth)
        .send({ worker_id: 'g-trust', job_id: job.job_id, attempt: job.attempt, framework_version: GRADER_FRAMEWORK, grades });
      expect(out.status).toBe(200);
      graded += 1;
    }
  }

  /** Appends one SYNTHETIC label line to this test's labels/<set>.jsonl, each a second after the last. */
  async function label(set: 'tuning' | 'heldout', trialId: string, value: string, opts: { criterion?: string; rater?: string; second_look?: boolean; note?: string } = {}): Promise<void> {
    clock += 1000;
    const line = {
      item_id: trialId,
      trial_id: trialId,
      set,
      rater: opts.rater ?? 'rishi',
      criterion: opts.criterion ?? 'overall',
      value,
      note: opts.note ?? null,
      labelled_at: new Date(clock).toISOString(),
      ...(opts.second_look ? { second_look: true } : {}),
    };
    await fs.mkdir(env.labelsDir, { recursive: true });
    await fs.appendFile(path.join(env.labelsDir, `${set}.jsonl`), `${JSON.stringify(line)}\n`);
  }

  const trust = async (query = ''): Promise<JudgeTrustResponse> => (await request(env.http).get(`/api/judge/trust${query}`).expect(200)).body as JudgeTrustResponse;
  const judgeOf = async (model: string, query = ''): Promise<JudgeTrust> => {
    const j = (await trust(query)).judges.find((x) => x.judge_model === model);
    if (!j) throw new Error(`no judge ${model}`);
    return j;
  };
  const overall = (j: JudgeTrust) => j.criteria.find((c) => c.criterion === 'overall')!;

  it('shows a judge nobody has labelled as uncalibrated, and keeps an experiment’s own judges with ?experiment=', async () => {
    const empty = await trust();
    expect(empty.bar).toEqual({ kappa: 0.6, kappa_low: 0.4, retest: 0.9, min_human_no: 5, max_undefined_share: 0.05, resamples: 2000, human_unsure: 'exclude' });

    const exp = await run([A], ['trust-held-1'], 3);
    expect(await judge('fake/judge-uncal', () => ({ overall: 'yes', plain: 'yes' }))).toBe(3);
    const j = await judgeOf('fake/judge-uncal');
    expect(j).toMatchObject({
      judge_model: 'fake/judge-uncal',
      rubric: RUBRIC,
      experiments: [exp.id],
      trials_judged: 3,
      status: 'uncalibrated',
      summary: 'No human labels on outputs this judge graded yet. Treat its verdicts as a hint, and label a few to calibrate it.',
    });
    expect(j.criteria.map((c) => [c.criterion, c.text, c.status, c.needs_human_no, c.heldout, c.tuning, c.d8, c.retest])).toEqual([
      ['overall', 'Would a real client in this situation be well served by this?', 'uncalibrated', 5, null, null, null, null],
      ['plain', 'Does it explain each figure in plain words?', 'uncalibrated', 5, null, null, null, null],
    ]);

    // Another experiment with another judge: the filter keeps each experiment's own judges only.
    const other = await run([A], ['trust-held-2'], 1);
    await judge('fake/judge-other', () => ({ overall: 'no', plain: 'yes' }));
    expect((await trust(`?experiment=${exp.id}`)).judges.map((x) => x.judge_model)).toEqual(['fake/judge-uncal']);
    expect((await trust(`?experiment=${other.id}`)).judges.map((x) => x.judge_model)).toEqual(['fake/judge-other']);
    expect((await trust()).judges.map((x) => x.judge_model).sort()).toEqual(['fake/judge-other', 'fake/judge-uncal']);
  });

  it('refuses an unknown experiment (404) and a repeated one (400)', async () => {
    const missing = await request(env.http).get('/api/judge/trust?experiment=e_not_there').expect(404);
    expect(missing.body).toMatchObject({ error: 'unknown_experiment' });
    const twice = await request(env.http).get('/api/judge/trust?experiment=a&experiment=b').expect(400);
    expect(twice.body).toMatchObject({ error: 'invalid_query' });
  });

  it('shows tuning labels alone as tuning_only: agreement shown, never tested blind', async () => {
    const exp = await run([A], ['trust-tune'], 6);
    const byRepeat = new Map(exp.trials.map((t) => [t.repeat, t.id]));
    const judged = new Map(exp.trials.map((t) => [t.id, t.repeat < 4 ? 'yes' : 'no']));
    await judge('fake/judge-tune', (id) => ({ overall: judged.get(id)!, plain: 'yes' }));
    // Humans: yes, yes, yes, no, no, yes against the judge's yes, yes, yes, yes, no, no.
    for (const [r, v] of ['yes', 'yes', 'yes', 'no', 'no', 'yes'].entries()) await label('tuning', byRepeat.get(r)!, v);
    const c = overall(await judgeOf('fake/judge-tune'));
    expect(c.status).toBe('tuning_only');
    expect(c.heldout).toBeNull();
    expect(c.d8).toBeNull();
    expect(c.tuning).toMatchObject({ n: 6, tp: 3, fp: 1, fn: 1, tn: 1, human_no: 2, human_left_out: 0, judge_undecided: 0, false_pass_gap: null });
    expect(c.tuning!.kappa).toBeCloseTo(0.25, 10);
    expect(c.summary).toBe('Agrees with 6 tuning labels at kappa 0.25, but has never been tested on held-out labels, which decide trust.');
    expect(c.disagreements.map((d) => [d.trial_id, d.set, d.human, d.judge, d.judge_reason])).toEqual(
      expect.arrayContaining([
        [byRepeat.get(3), 'tuning', 'no', 'yes', 'judge says yes on overall'],
        [byRepeat.get(5), 'tuning', 'yes', 'no', 'judge says no on overall'],
      ]),
    );
    expect(c.disagreements).toHaveLength(2);
    // `plain` has no labels: uncalibrated; the judge's own status is its overall criterion's.
    const j = await judgeOf('fake/judge-tune');
    expect(j.criteria.find((x) => x.criterion === 'plain')!.status).toBe('uncalibrated');
    expect(j.status).toBe('tuning_only');
  });

  it('settles each rater’s label (a second look, a relabel, a raters’ tie) and shows too_few held-out "no" labels', async () => {
    const exp = await run([A], ['trust-held-1'], 6);
    const t = new Map(exp.trials.map((x) => [x.repeat, x.id]));
    const judged = ['no', 'yes', 'no', 'yes', 'yes', 'yes'];
    const repeatOf = new Map(exp.trials.map((x) => [x.id, x.repeat]));
    await judge('fake/judge-few', (id) => ({ overall: judged[repeatOf.get(id)!], plain: 'yes' }));
    await label('heldout', t.get(0)!, 'no');
    await label('heldout', t.get(1)!, 'yes');
    await label('heldout', t.get(2)!, 'unsure');
    await label('heldout', t.get(2)!, 'no', { second_look: true }); // D46: replaces the unsure
    await label('heldout', t.get(3)!, 'yes');
    await label('heldout', t.get(3)!, 'no', { rater: 'asha' }); // D73: a tie between raters, left out
    await label('heldout', t.get(4)!, 'yes');
    await label('heldout', t.get(5)!, 'yes');
    await label('heldout', t.get(5)!, 'no'); // a relabel: the first label counts
    const c = overall(await judgeOf('fake/judge-few'));
    expect(c.status).toBe('too_few');
    expect(c.heldout).toMatchObject({ n: 5, tp: 3, fp: 0, fn: 0, tn: 2, human_no: 2, human_left_out: 1, judge_undecided: 0 });
    expect(c.needs_human_no).toBe(3);
    expect(c.summary).toBe('5 held-out labels so far; needs 3 more human "no" labels before the trust bar can be applied.');
    expect(c.d8!.trusted).toBe(false);
    expect(c.d8!.reasons[0]).toBe('2 human "no" labels, fewer than 5');
    expect(c.disagreements).toEqual([]);
  });

  it('shows a judge below the bar as not_trusted, with its disagreements, held-out first, and the notes', async () => {
    const exp = await run([A], ['trust-held-1', 'trust-tune'], 8);
    const held = exp.trials.filter((x) => x.task === 'trust-held-1');
    const tune = exp.trials.filter((x) => x.task === 'trust-tune');
    const human = (x: Ran) => (x.repeat < 6 ? 'no' : 'yes');
    // The judge says the opposite of the humans every time.
    const byId = new Map(exp.trials.map((x) => [x.id, x]));
    await judge('fake/judge-bad', (id) => ({ overall: human(byId.get(id)!) === 'no' ? 'yes' : 'no', plain: 'yes' }));
    for (const x of held) await label('heldout', x.id, human(x), x.repeat === 0 ? { note: 'misses the late fee' } : {});
    for (const x of tune.filter((y) => y.repeat < 2)) await label('tuning', x.id, 'no');
    const j = await judgeOf('fake/judge-bad');
    const c = overall(j);
    expect(c.status).toBe('not_trusted');
    expect(j.status).toBe('not_trusted');
    expect(c.heldout).toMatchObject({ n: 8, tp: 0, fp: 6, fn: 2, tn: 0, human_no: 6 });
    expect(c.heldout!.kappa).toBeCloseTo(-0.6, 10);
    expect(c.summary).toBe('Not trusted: kappa -0.60 on 8 held-out labels is below 0.6.');
    expect(j.summary).toBe(c.summary);
    expect(c.d8!.reasons).toEqual(expect.arrayContaining(['kappa -0.60 is below 0.6', 'the false-pass gap between arms could not be measured', 'test-retest agreement is not measured']));
    expect(c.tuning).toMatchObject({ n: 2, fp: 2 });
    expect(c.disagreements).toHaveLength(10);
    expect(c.disagreements.slice(0, 8).every((d) => d.set === 'heldout' && d.task_id === 'trust-held-1')).toBe(true);
    expect(c.disagreements.slice(8).every((d) => d.set === 'tuning' && d.task_id === 'trust-tune')).toBe(true);
    const first = held.find((x) => x.repeat === 0)!;
    expect(c.disagreements.find((d) => d.trial_id === first.id)).toEqual({
      trial_id: first.id,
      task_id: 'trust-held-1',
      set: 'heldout',
      human: 'no',
      judge: 'yes',
      judge_reason: 'judge says yes on overall',
      human_note: 'misses the late fee',
    });
  });

  it('trusts a judge only once D8 holds, test-retest measured by a regrade, and fills the comparison’s stats.judge', async () => {
    const exp = await run([A, B], ['trust-held-1', 'trust-held-2'], 10);
    const human = (x: Ran) => (x.repeat < 5 ? 'no' : 'yes');
    // The judge agrees with the humans but for one false pass per arm (trust-held-1, repeat 0).
    const judged = (x: Ran) => (x.task === 'trust-held-1' && x.repeat === 0 ? 'yes' : human(x));
    const byId = new Map(exp.trials.map((x) => [x.id, x]));
    const verdicts = (id: string) => ({ overall: judged(byId.get(id)!), plain: 'yes' });
    expect(await judge('fake/judge-good', verdicts)).toBe(40);
    for (const x of exp.trials) await label('heldout', x.id, human(x));

    let c = overall(await judgeOf('fake/judge-good'));
    expect(c.heldout).toMatchObject({ n: 40, tp: 20, fp: 2, fn: 0, tn: 18, human_no: 20 });
    expect(c.heldout!.kappa).toBeCloseTo(0.9, 10);
    expect(c.heldout!.false_pass_gap).toMatchObject({ experiment_id: exp.id, estimate: 0, includes_zero: true });
    // Judged once: test-retest is not measured, so D8 cannot pass yet.
    expect(c.retest).toBeNull();
    expect(c.status).toBe('not_trusted');
    expect(c.d8).toEqual({ trusted: false, reasons: ['test-retest agreement is not measured'] });

    // A regrade is a second grading of every trial; the judge gives the same verdicts.
    await request(env.http).post(`/api/experiments/${exp.id}/regrade`).send({}).expect(202);
    expect(await judge('fake/judge-good', verdicts)).toBe(40);
    const j = await judgeOf('fake/judge-good');
    c = overall(j);
    expect(c.retest).toEqual({ identical: 40, total: 40, share: 1 });
    expect(c.d8).toEqual({ trusted: true, reasons: [] });
    expect(c.status).toBe('trusted');
    expect(j.status).toBe('trusted');
    const k = c.heldout!.kappa_interval;
    expect(k.low!).toBeGreaterThanOrEqual(0.4);
    expect(c.summary).toBe(`Trusted: kappa 0.90 (interval ${k.low!.toFixed(2)} to ${k.high!.toFixed(2)}) on 40 held-out labels, no false-pass gap between arms, and 100% test-retest agreement.`);
    expect(j.trials_judged).toBe(40);
    expect(j.experiments).toEqual([exp.id]);
    // The same data gives the same intervals.
    expect(overall(await judgeOf('fake/judge-good')).heldout).toEqual(c.heldout);

    const cmp = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as CompareResponse;
    expect(cmp.status).toBe('complete');
    expect(cmp.stats!.judge).toEqual({ kappa: c.heldout!.kappa, low: k.low, high: k.high, bar: 0.6, tasks: 2 });
  });

  it('leaves the comparison’s stats.judge null without held-out labels on its judge', async () => {
    const exp = await run([A, B], ['trust-held-2'], 2);
    await judge('fake/judge-nolabels', () => ({ overall: 'yes', plain: 'yes' }));
    const cmp = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as CompareResponse;
    expect(cmp.status).toBe('complete');
    expect(cmp.stats!.judge).toBeNull();
  });
});
