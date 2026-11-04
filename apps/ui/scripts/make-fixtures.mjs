// Writes the UI's sample data (src/fixtures/*.json) in the shapes of docs/api-contract.md.
// The numbers and words come from the approved SP7 artboards (4 Nov). Nothing here is a real
// result, and none of it is a human label: the labelling queue holds outputs to label, never
// answers. Run from apps/ui: node scripts/make-fixtures.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'fixtures');
mkdirSync(out, { recursive: true });
const write = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n');

/** The fixed "now" every fixture time is relative to (src/fixtures/index.ts uses the same). */
const NOW = Date.parse('2026-11-05T14:08:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const sha = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');
/** A hash whose short form reads as the artboards show it. */
const named = (prefix) => 'sha256:' + prefix + createHash('sha256').update(prefix).digest('hex').slice(prefix.length);

// ------------------------------------------------------------------------------- catalogue

const TOOLS = [
  'calculate_emi', 'amortization_schedule', 'prepayment_impact', 'debt_payoff_plan', 'sip_future_value', 'fd_maturity',
  'inflation_adjusted_value', 'loan_affordability', 'get_client_profile', 'list_debts', 'list_transactions',
];
const toolset = { id: 'finance/all', version: '1', sha256: named('e4c1f08'), servers: [{ name: 'finance', allowed_tools: TOOLS }] };

const v1Text = readFileSync(join(here, '..', '..', '..', 'configs', 'prompts', 'finance-advisor.v1.md'), 'utf8')
  .replace(/^<!--[\s\S]*?-->\s*/, '');
const v2Text = v1Text
  .replace('Stay under about 250 words unless the client asks for detail.', 'Stay under about 200 words.')
  .replace('- **Read the person before the numbers.**', '- **Read the person before the numbers.** If the client is in distress, respond to that before any numbers.');
const prompts = [
  { id: 'finance-advisor', version: 'v2', sha256: named('9d24e7b'), path: 'configs/prompts/finance-advisor.v2.md', text: v2Text },
  { id: 'finance-advisor', version: 'v1', sha256: named('5c0f1a2'), path: 'configs/prompts/finance-advisor.v1.md', text: v1Text },
];

const models = [
  { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5 },
  { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75 },
];

const HAIKU = 'claude-haiku-5-5';
const effective = { [HAIKU]: { status: 'effective', evidence: 'effect check 2026-11-04' } };
const notChecked = { [HAIKU]: { status: 'not_checked', evidence: 'not run yet' } };
const s = (supported, evidence, extra = {}) => ({ supported, evidence, ...extra });
const pending = (native) => s(true, 'none', { native });
const capabilities = (harness, pkg, ref, settings, known, options = {}) => ({
  contract_version: '2',
  harness,
  version: { package: pkg, ref },
  model_api_formats: ['openai_chat'],
  settings,
  harness_options_schema: { type: 'object', additionalProperties: false, properties: options },
  known_differences: known,
});
const watchdog = s(true, "declared:the adapter library's watchdog", { native: 'adapter watchdog', observed: 'Adapter watchdog' });
const harnesses = [
  {
    name: 'hermes', package: 'hermes-agent', ref: '6112c2adb9e11f69734a29be9d2696f345ffa06a', python: '3.11',
    capabilities: capabilities('hermes', 'hermes-agent', '6112c2adb9e11f69734a29be9d2696f345ffa06a', {
      temperature: s(true, 'probe:2026-11-03', { native: 'temperature', default: null, observed: 'Not sent unless set', effect: effective }),
      max_output_tokens: s(true, 'probe:2026-11-03', { native: 'max_tokens', default: null, observed: 'Sent as max_tokens', effect: effective }),
      max_steps: s(true, 'probe:2026-11-03', { native: 'max_iterations, per turn', extra_calls_at_limit: 2, observed: '2 extra calls at the limit; it counts only its own', effect: effective }),
      timeout_s: watchdog,
      parallel_tool_calls: s(true, 'probe:2026-11-03', { native: 'parallel_tool_calls', default: null, effect: notChecked }),
      memory: s(true, 'declared:a request cannot show memory being off', { native: 'memory toolset', default: false, observed: 'Off unless the config turns it on', effect: notChecked }),
      skills: s(true, 'declared:a request cannot show skills being off', { native: 'skills toolset', default: false, observed: 'Off unless the config turns it on', effect: notChecked }),
      compression: s(true, 'declared:hermes-notes', { native: 'compression.enabled', default: true, observed: 'Hermes turns it on by default; we turn it off', effect: notChecked }),
    }, [
      "Repairs broken tool-call JSON and runs the tool without telling the model. If it can't, it runs the tool with empty arguments.",
      'Tool names reach the model as mcp__finance__<name>, and tool results are wrapped as untrusted content.',
      'Adds its own identity text and the date to the system prompt.',
    ], {
      prompt_cache_markers: { type: 'boolean', description: "Hermes's own cache_control markers for Claude models. Default: Hermes's behaviour (on)." },
    }),
  },
  {
    name: 'ownloop', package: 'ownloop', ref: '0.1.0', python: '3.11',
    capabilities: capabilities('ownloop', 'ownloop', '0.1.0', {
      temperature: s(true, 'probe:2026-11-03', { native: 'temperature', default: null, observed: 'Not sent unless set', effect: effective }),
      max_output_tokens: s(true, 'probe:2026-11-03', { native: 'max_tokens', default: null, observed: 'Sent as max_tokens', effect: effective }),
      max_steps: s(true, 'probe:2026-11-03', { native: 'loop counter', extra_calls_at_limit: 0, observed: 'Stops exactly at the limit', effect: effective }),
      timeout_s: watchdog,
      parallel_tool_calls: s(true, 'probe:2026-11-03', { native: 'parallel_tool_calls', default: null }),
      memory: s(false, 'declared:no such feature', { observed: '' }),
      skills: s(false, 'declared:no such feature', { observed: '' }),
      compression: s(false, 'declared:no such feature', { observed: 'Always sends the full history' }),
    }, ['Sends the task system prompt as it is, with nothing added.']),
  },
  {
    name: 'langgraph', package: 'langgraph', ref: '1.2.16', python: '3.12',
    capabilities: capabilities('langgraph', 'langgraph', '1.2.16', {
      temperature: pending('ChatOpenAI(temperature=)'), max_output_tokens: pending('ChatOpenAI(max_tokens=)'),
      max_steps: pending('ModelCallLimitMiddleware'), timeout_s: watchdog, parallel_tool_calls: pending('bind_tools(parallel_tool_calls=)'),
      memory: pending(''), skills: pending(''), compression: pending(''),
    }, ['Switches to the Responses API for some model names; the adapter pins Chat Completions.']),
  },
  {
    name: 'adk', package: 'google-adk', ref: '2.12.0', python: '3.12',
    capabilities: capabilities('adk', 'google-adk', '2.12.0', {
      temperature: s(true, 'probe:2026-11-04', { native: 'generate_content_config.temperature', default: null, observed: 'Not sent unless set', effect: { [HAIKU]: { status: 'inert', evidence: 'effect check 2026-11-04: no change between 0 and 1' } } }),
      max_output_tokens: pending('generate_content_config.max_output_tokens'), max_steps: pending('RunConfig.max_llm_calls'),
      timeout_s: watchdog, parallel_tool_calls: pending('LiteLlm(parallel_tool_calls=)'),
      memory: pending(''), skills: pending(''), compression: pending(''),
    }, ['Wraps every tool description in untrusted-content markers and adds an identity line.']),
  },
  {
    name: 'openai-agents', package: 'openai-agents', ref: '0.24.0', python: '3.12',
    capabilities: capabilities('openai-agents', 'openai-agents', '0.24.0', {
      temperature: pending('ModelSettings.temperature'), max_output_tokens: pending('ModelSettings.max_tokens'),
      max_steps: pending('Runner.run max_turns'), timeout_s: watchdog, parallel_tool_calls: pending('ModelSettings.parallel_tool_calls'),
      memory: pending(''), skills: pending(''), compression: pending(''),
    }, ['Replaces malformed-argument errors with a fixed "please try again" message.']),
  },
];

// Tasks: the 12 held-out tasks of the artboards, then 12 discovery tasks.
const T = (id, summary, split, graders, kind) => ({ id, summary, split, graders: graders.map((kind) => ({ kind })), kind });
const taskList = [
  T('distress-12', 'Client sounds hopeless about debt. Responds with care first and points to help.', 'heldout', ['judge'], 'conversation'),
  T('debt-hardship-03', 'Loan taken after a death in the family. Stability before optimisation, no blame.', 'heldout', ['judge', 'state'], 'conversation'),
  T('debt-regret-04', 'Phone bought on EMI to keep up with friends. Kind, direct, real cost in rupees.', 'heldout', ['judge'], 'single'),
  T('scam-otp-10', 'Someone asks the client for an OTP. Never asks for one and warns the client.', 'heldout', ['exact'], 'conversation'),
  T('afford-car-06', 'Can the client afford a car loan? Uses the FOIR limit from the affordability tool.', 'heldout', ['unit'], 'single'),
  T('emi-prepay-02', 'Effect of a ₹2 lakh part-prepayment on tenure and interest.', 'heldout', ['exact'], 'single'),
  T('profile-gap-11', 'Profile is missing income. Asks one clear question instead of guessing.', 'heldout', ['state'], 'conversation'),
  T('emi-basic-01', 'EMI on a ₹10 lakh loan at 9% for 20 years.', 'heldout', ['exact'], 'single'),
  T('sip-goal-05', 'Monthly SIP needed to reach ₹25 lakh in 10 years.', 'heldout', ['exact'], 'single'),
  T('inflation-09', 'What ₹1 crore in 20 years is worth today at 6% inflation.', 'heldout', ['unit'], 'single'),
  T('payoff-order-08', 'Three debts, one budget. Orders the payoff plan correctly.', 'heldout', ['state'], 'single'),
  T('fd-vs-sip-07', 'FD or SIP for a 5-year goal, accounting for tax on FD interest.', 'heldout', ['judge'], 'single'),
  T('loan-for-loan-14', 'Client wants a new loan to clear a credit card. Checks the total cost first.', 'discovery', ['judge', 'unit'], 'conversation'),
  T('sip-step-up-15', 'Monthly SIP needed for ₹50 lakh in 15 years, with inflation.', 'discovery', ['exact'], 'single'),
  T('emi-tenure-13', 'Shorter tenure or lower EMI after a rate cut.', 'discovery', ['exact'], 'single'),
  T('gold-loan-16', 'Gold loan against a personal loan for a ₹1 lakh need.', 'discovery', ['judge'], 'single'),
  T('card-minimum-17', 'Paying only the minimum due on a credit card. Names the real cost.', 'discovery', ['unit'], 'single'),
  T('home-loan-tax-18', 'Prepay a home loan or invest, given the interest deduction.', 'discovery', ['judge'], 'single'),
  T('ppf-vs-elss-19', 'PPF or ELSS for a first-time investor with a 3-year horizon.', 'discovery', ['judge'], 'single'),
  T('budget-split-20', 'Monthly budget from the transactions: essentials, savings, debt.', 'discovery', ['state'], 'single'),
  T('emergency-fund-21', 'Size of an emergency fund from the profile and fixed costs.', 'discovery', ['unit'], 'single'),
  T('rent-vs-buy-22', 'Rent or buy a flat in Pune, using the affordability tool.', 'discovery', ['unit'], 'single'),
  T('retire-corpus-23', 'Corpus needed to retire at 55 with 6% inflation.', 'discovery', ['exact'], 'conversation'),
  T('bonus-split-24', 'Split a ₹1.5 lakh bonus between debts and savings.', 'discovery', ['state'], 'single'),
];
const tasks = taskList.map((t) => ({ sha256: sha(`task:${t.id}:1`), id: t.id, version: '1', split: t.split, kind: t.kind, summary: t.summary, graders: t.graders }));
const task = Object.fromEntries(tasks.map((t) => [t.id, t]));
const heldout = tasks.filter((t) => t.split === 'heldout');
const discovery = tasks.filter((t) => t.split === 'discovery');

// ------------------------------------------------------------------------------- configs

const baseSettings = { temperature: 0.2, max_output_tokens: 1024, max_steps: 12, timeout_s: 180, parallel_tool_calls: false, memory: false, skills: false, compression: false };
const sources = (settings, unsupported = []) => ({
  ...Object.fromEntries(Object.keys(settings).map((k) => [k, 'config'])),
  ...Object.fromEntries(unsupported.map((k) => [k, 'unsupported'])),
});
const promptRef = (p) => ({ id: p.id, version: p.version, sha256: p.sha256 });
const toolsetRef = { id: toolset.id, version: toolset.version, sha256: toolset.sha256 };
const [v2, v1] = prompts;
const cfgV1 = {
  hash: named('3b81e04'), name: 'Prompt v1 on Hermes', harness: 'hermes', harness_ref: harnesses[0].ref, model: HAIKU,
  prompt: promptRef(v1), toolset: toolsetRef, settings: baseSettings, settings_sources: sources(baseSettings), harness_options: {}, created_at: at(3 * 1440),
};
const cfgV2 = { ...cfgV1, hash: named('7f3a9c2'), name: 'Prompt v2 on Hermes', prompt: promptRef(v2), created_at: at(2 * 1440 + 200) };
const ownSettings = { temperature: 0.2, max_output_tokens: 1024, max_steps: 12, timeout_s: 180, parallel_tool_calls: false };
const cfgOwn = {
  ...cfgV1, hash: named('a91c4d0'), name: 'Own loop, prompt v1', harness: 'ownloop', harness_ref: '0.1.0',
  settings: ownSettings, settings_sources: sources(ownSettings, ['memory', 'skills', 'compression']), created_at: at(1440 + 300),
};
const configs = [cfgV2, cfgOwn, cfgV1];

// ------------------------------------------------------------------------------- experiments

const counts = (done, running = 0, queued = 0, infra = 0) => ({ queued, running, done, infra_failed: infra, abandoned: 0, cancelled: 0 });
const estimate = (trials, expected, low, high, minutes, extra = {}) => ({
  trials, cost_usd: { expected, low, high }, minutes, basis: 'Mean tokens of the pilot trials (40 trials on Hermes with Claude Haiku 5.5); prices from LiteLLM', concurrency: 4, ...extra,
});
const exp = (o) => ({ task_sha256s: [], budget_usd: 40, plan_commit: '3e1a9f0', platform_commit: 'c4d2e19', sim_model: HAIKU, started_at: null, finished_at: null, ...o });
const experiments = [
  exp({
    id: 'exp_harness', name: 'Harness: own loop vs Hermes', axis: 'harness', status: 'running', config_hashes: [cfgOwn.hash, cfgV1.hash], n: 5,
    counts: counts(60, 4, 54, 2), spend_usd: 11.2, estimate: estimate(120, 21.3, 16, 27, 38, { min_detectable_effect: { points: 10, power: 0.8 } }),
    created_at: at(30), started_at: at(27), task_sha256s: heldout.map((t) => t.sha256),
  }),
  exp({
    id: 'exp_heldout', name: 'Prompt v1 vs v2, held-out', axis: 'prompt', status: 'done', config_hashes: [cfgV1.hash, cfgV2.hash], n: 5,
    counts: counts(120, 0, 0, 2), spend_usd: 18.4, estimate: estimate(120, 21.3, 16, 27, 38, { min_detectable_effect: { points: 10, power: 0.8 } }),
    created_at: at(170), started_at: at(165), finished_at: at(120), task_sha256s: heldout.map((t) => t.sha256),
  }),
  exp({
    id: 'exp_discovery', name: 'Prompt v1 vs v2, discovery', axis: 'prompt', status: 'done', config_hashes: [cfgV1.hash, cfgV2.hash], n: 5,
    counts: counts(80), spend_usd: 12.1, estimate: estimate(80, 14, 10.5, 18, 26), created_at: at(1500), started_at: at(1495), finished_at: at(1460),
    task_sha256s: discovery.slice(0, 8).map((t) => t.sha256),
  }),
  exp({
    id: 'exp_aa', name: 'A/A check, Hermes', axis: 'none', status: 'done', config_hashes: [cfgV1.hash, cfgV1.hash], n: 5,
    counts: counts(100), spend_usd: 9.1, estimate: estimate(100, 10.4, 7.8, 13.2, 32), created_at: at(1620), started_at: at(1615), finished_at: at(1570),
    task_sha256s: heldout.slice(0, 10).map((t) => t.sha256),
  }),
  exp({
    id: 'exp_pilot', name: 'Pilot on Haiku 5.5', axis: 'none', status: 'done', config_hashes: [cfgV1.hash], n: 5,
    counts: counts(40), spend_usd: 3.3, estimate: { ...estimate(40, 4, 3, 5.2, 14), basis: 'Assumptions in docs/cost.md: 64k input and 2.4k output tokens per trial' },
    created_at: at(2950), started_at: at(2945), finished_at: at(2900), task_sha256s: discovery.slice(0, 8).map((t) => t.sha256),
  }),
];

// Trials for the held-out experiment: per-task pass counts from the compare artboard.
const heldoutCounts = {
  'distress-12': [1, 5], 'debt-hardship-03': [2, 5], 'debt-regret-04': [2, 4], 'scam-otp-10': [3, 4], 'afford-car-06': [3, 4],
  'emi-prepay-02': [4, 5], 'profile-gap-11': [2, 2], 'emi-basic-01': [5, 5], 'sip-goal-05': [4, 4], 'inflation-09': [2, 2],
  'payoff-order-08': [3, 2], 'fd-vs-sip-07': [4, 2],
};
const passPattern = (passed, salt) => {
  const order = [0, 1, 2, 3, 4].sort((x, y) => ((x * 3 + salt) % 5) - ((y * 3 + salt) % 5));
  const set = new Set(order.slice(0, passed));
  return [0, 1, 2, 3, 4].map((i) => set.has(i));
};
const jitter = (i, spread) => ((i * 7919) % 100) / 100 * spread - spread / 2;
const trialRow = (id, t, cfg, repeat, attempt, status, label, passed, i, arm) => ({
  id, task: t.sha256, config: cfg.hash, repeat_index: repeat, attempt, status, label,
  end_state: status === 'done' ? 'answered' : null, passed,
  cost_usd: status === 'done' || status === 'infra_failed' ? Number(((arm === 'a' ? 0.15 : 0.16) + jitter(i, 0.06)).toFixed(4)) : null,
  wall_s: status === 'done' ? Number(((arm === 'a' ? 41 : 43) + jitter(i, 14)).toFixed(1)) : null,
  input_tokens: status === 'done' ? Math.round((arm === 'a' ? 16000 : 16600) + jitter(i, 3000)) : null,
  output_tokens: status === 'done' ? Math.round((arm === 'a' ? 2200 : 2300) + jitter(i, 600)) : null,
});
const tid = (taskId, arm, repeat, attempt = 1) => `tr_${taskId}_${arm}_${repeat + 1}${attempt > 1 ? `_attempt${attempt}` : ''}`;
const heldoutTrials = [];
let k = 0;
heldout.forEach((t, ti) => {
  [['a', cfgV1], ['b', cfgV2]].forEach(([arm, cfg], ai) => {
    let pattern = passPattern(heldoutCounts[t.id][ai], ti + ai);
    if (t.id === 'fd-vs-sip-07' && arm === 'b') pattern = [true, true, false, false, false];
    pattern.forEach((p, r) => {
      const infra = (t.id === 'debt-hardship-03' && arm === 'b' && r === 1) || (t.id === 'fd-vs-sip-07' && arm === 'b' && r === 1);
      if (infra) {
        heldoutTrials.push(trialRow(tid(t.id, arm, r), t, cfg, r, 1, 'infra_failed', 'infra:provider_error', null, k++, arm));
        heldoutTrials.push(trialRow(tid(t.id, arm, r, 2), t, cfg, r, 2, 'done', 'agent', p, k++, arm));
      } else {
        heldoutTrials.push(trialRow(tid(t.id, arm, r), t, cfg, r, 1, 'done', 'agent', p, k++, arm));
      }
    });
  });
});

// Trials for the running experiment, in the engine's claim order: repeat by repeat, then task by
// task in the grid's row order, the two arms alternating, so seq = repeat * 24 + task * 2 + arm
// (experiments.service.ts interleaves the arms this way, so a cancel or a budget trip part-way
// leaves them balanced). The first 62 first attempts are claimed and finished: 60 done, and two
// infra stops in arm B, each re-queued as attempt 2. The next 4 run (the estimate's concurrency,
// two in each arm) and the other 54 wait.
const HARNESS_CLAIMED = 62;
const HARNESS_RUNNING = 4;
// Each task's claimed first attempts, trial by trial, arm A then arm B: p passed, f failed,
// i stopped on an infra failure.
const harnessOutcomes = {
  'distress-12': ['ffp', 'pfp'], 'debt-hardship-03': ['ffp', 'pip'], 'debt-regret-04': ['pff', 'ppf'],
  'scam-otp-10': ['ppf', 'ppp'], 'afford-car-06': ['fpf', 'ppp'], 'emi-prepay-02': ['pfp', 'ppp'],
  'profile-gap-11': ['fpp', 'pfp'], 'emi-basic-01': ['pp', 'pp'], 'sip-goal-05': ['pp', 'pp'],
  'inflation-09': ['pf', 'pp'], 'payoff-order-08': ['pf', 'fp'], 'fd-vs-sip-07': ['pp', 'pi'],
};
const harnessTrials = [];
k = 0;
for (let r = 0; r < 5; r++) {
  heldout.forEach((t, ti) => {
    [['a', cfgOwn], ['b', cfgV1]].forEach(([arm, cfg], ai) => {
      const seq = r * heldout.length * 2 + ti * 2 + ai;
      const id = `th_${t.id}_${arm}_${r + 1}`;
      if (seq < HARNESS_CLAIMED) {
        const c = harnessOutcomes[t.id][ai][r];
        if (c === 'i') {
          harnessTrials.push(trialRow(id, t, cfg, r, 1, 'infra_failed', 'infra:provider_error', null, k++, arm));
          harnessTrials.push(trialRow(`${id}_attempt2`, t, cfg, r, 2, 'queued', null, null, k++, arm));
        } else {
          harnessTrials.push(trialRow(id, t, cfg, r, 1, 'done', 'agent', c === 'p', k++, arm));
        }
      } else if (seq < HARNESS_CLAIMED + HARNESS_RUNNING) {
        harnessTrials.push(trialRow(id, t, cfg, r, 1, 'running', null, null, k++, arm));
      } else {
        harnessTrials.push(trialRow(id, t, cfg, r, 1, 'queued', null, null, k++, arm));
      }
    });
  });
}

const rowsFrom = (trials, cfgs) => {
  const rows = [];
  const seen = new Map();
  for (const t of trials) {
    const key = `${t.task}|${t.config}`;
    if (!seen.has(key)) {
      const row = { task: t.task, config: t.config, passed: 0, graded: 0, trials: 0 };
      seen.set(key, row);
      rows.push(row);
    }
  }
  for (const t of trials) {
    if (t.status !== 'done') continue;
    const row = seen.get(`${t.task}|${t.config}`);
    row.trials += 1;
    if (t.passed !== null) {
      row.graded += 1;
      if (t.passed) row.passed += 1;
    }
  }
  return cfgs ? rows : rows;
};

const I = (estimate, low, high) => ({ estimate, low, high });
const heldoutTaskStats = [
  ['distress-12', 80, 40, 100, true], ['debt-hardship-03', 60, 20, 100, true], ['debt-regret-04', 40, -10, 90, false],
  ['scam-otp-10', 20, -30, 70, false], ['afford-car-06', 20, -30, 70, false], ['emi-prepay-02', 20, -20, 60, false],
  ['profile-gap-11', 0, -50, 50, false], ['emi-basic-01', 0, -20, 20, false], ['sip-goal-05', 0, -40, 40, false],
  ['inflation-09', 0, -50, 50, false], ['payoff-order-08', -20, -70, 30, false], ['fd-vs-sip-07', -40, -90, 10, false],
].map(([id, d, lo, hi, significant]) => ({ task: task[id].sha256, diff: I(d, lo, hi), significant }));

const compares = {
  exp_heldout: {
    rows: rowsFrom(heldoutTrials),
    stats: {
      measure: 'pass_rate', level: 0.95,
      a: { rate: 35 / 60, passed: 35, graded: 60 }, b: { rate: 44 / 60, passed: 44, graded: 60 },
      diff: I(15, 7, 23), p_value: 0.003, method: 'paired_task_bootstrap', verdict: 'better',
      tasks: heldoutTaskStats, correction: 'holm', aa: { experiment_id: 'exp_aa', diff: I(1, -7, 9) },
      costs: [
        { metric: 'cost_usd', a: 0.15, b: 0.16, diff: I(0.01, 0.0015, 0.0165), relative: I(6, 1, 11) },
        { metric: 'wall_s', a: 41, b: 43, diff: I(2, -1, 5), relative: null },
        { metric: 'tokens', a: 18200, b: 18900, diff: I(700, 180, 1270), relative: I(4, 1, 7) },
      ],
      judge: { kappa: 0.7, low: 0.47, high: 0.88, bar: 0.6 },
    },
  },
  exp_discovery: {
    rows: discovery.slice(0, 8).flatMap((t, i) => [
      { task: t.sha256, config: cfgV1.hash, passed: [3, 2, 4, 1, 3, 2, 5, 2][i], graded: 5, trials: 5 },
      { task: t.sha256, config: cfgV2.hash, passed: [4, 3, 4, 2, 4, 2, 5, 3][i], graded: 5, trials: 5 },
    ]),
    stats: {
      measure: 'pass_rate', level: 0.95, a: { rate: 22 / 40, passed: 22, graded: 40 }, b: { rate: 27 / 40, passed: 27, graded: 40 },
      diff: I(11, -1, 23), p_value: 0.09, method: 'paired_task_bootstrap', verdict: 'no_clear_difference',
      tasks: discovery.slice(0, 8).map((t, i) => {
        const d = [20, 20, 0, 20, 20, 0, 0, 20][i];
        return { task: t.sha256, diff: I(d, d - 50, d + 50), significant: false };
      }),
      correction: 'holm', aa: { experiment_id: 'exp_aa', diff: I(1, -7, 9) }, costs: [], judge: null,
    },
  },
  exp_aa: {
    rows: heldout.slice(0, 10).flatMap((t, i) => [
      { task: t.sha256, config: cfgV1.hash, passed: [1, 2, 2, 3, 3, 4, 2, 5, 4, 2][i], graded: 5, trials: 5 },
      { task: t.sha256, config: cfgV1.hash, passed: [2, 2, 1, 3, 4, 4, 2, 5, 4, 2][i], graded: 5, trials: 5 },
    ]),
    stats: {
      measure: 'pass_rate', level: 0.95, a: { rate: 28 / 50, passed: 28, graded: 50 }, b: { rate: 29 / 50, passed: 29, graded: 50 },
      diff: I(1, -7, 9), p_value: 0.82, method: 'paired_task_bootstrap', verdict: 'no_clear_difference',
      tasks: heldout.slice(0, 10).map((t) => ({ task: t.sha256, diff: I(0, -40, 40), significant: false })),
      correction: 'holm', aa: null, costs: [], judge: null,
    },
  },
  exp_pilot: {
    rows: discovery.slice(0, 8).map((t, i) => ({ task: t.sha256, config: cfgV1.hash, passed: [3, 2, 4, 1, 3, 2, 5, 2][i], graded: 5, trials: 5 })),
    stats: null,
  },
  exp_harness: { rows: rowsFrom(harnessTrials), stats: null },
};

const events = {
  // In claim order: debt-hardship-03 B2 is claimed 28th and fd-vs-sip-07 B2 48th, and the
  // checkpoint comes with the 60th result, so it is the latest. Its spend is the run's spend now.
  exp_harness: [
    { at: '2026-11-05T13:41:00Z', kind: 'started', trial_id: null, message: 'Started 120 trials, 4 at a time, arms alternating.' },
    { at: '2026-11-05T13:53:00Z', kind: 'infra_failure', trial_id: 'th_debt-hardship-03_b_2', message: 'debt-hardship-03, arm B, trial 2: infra failure, the provider returned 429. Re-queued as attempt 2, the last.' },
    { at: '2026-11-05T14:01:00Z', kind: 'infra_failure', trial_id: 'th_fd-vs-sip-07_b_2', message: 'fd-vs-sip-07, arm B, trial 2: infra failure, the provider returned 429. Re-queued as attempt 2, the last.' },
    { at: '2026-11-05T14:07:00Z', kind: 'checkpoint', trial_id: null, message: 'Half the trials done. Spend is on track: $11.20 against $10.65 expected by now.' },
  ],
  exp_heldout: [
    { at: at(120), kind: 'finished', trial_id: null, message: 'All 120 trials finished. 2 infra failures, both provider errors, were re-run once each.' },
    { at: at(165), kind: 'started', trial_id: null, message: 'Started 120 trials, 4 at a time.' },
  ],
};

const configByHash = Object.fromEntries(configs.map((c) => [c.hash, c]));
const experimentDetails = Object.fromEntries(experiments.map((e) => [e.id, {
  ...e,
  tasks: e.task_sha256s.map((h) => tasks.find((t) => t.sha256 === h)),
  configs: [...new Set(e.config_hashes)].map((h) => configByHash[h]),
  events: events[e.id] ?? [{ at: e.finished_at ?? e.created_at, kind: 'finished', trial_id: null, message: `All ${e.estimate.trials} trials finished.` }],
}]));

// ------------------------------------------------------------------------------- one trial in full

const TRIAL = 'tr_fd-vs-sip-07_b_3';
const t0 = BigInt(Date.parse('2026-11-05T11:31:12Z')) * 1_000_000n;
const ns = (seconds) => String(t0 + BigInt(Math.round(seconds * 1000)) * 1_000_000n);
const traceId = createHash('sha256').update(TRIAL).digest('hex').slice(0, 32);
let spanN = 0;
const spanId = () => createHash('sha256').update(`${TRIAL}:${spanN++}`).digest('hex').slice(0, 16);
const attr = (key, value) => ({
  key,
  value: typeof value === 'string' ? { stringValue: value } : typeof value === 'boolean' ? { boolValue: value } : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
});
const otlp = (id, parent, name, start, end, attrs) => ({
  traceId, spanId: id, ...(parent ? { parentSpanId: parent } : {}), name, kind: 1,
  startTimeUnixNano: ns(start), endTimeUnixNano: ns(end), attributes: Object.entries(attrs).map(([k2, v]) => attr(k2, v)), status: { code: 1 },
});
const root = spanId();
const turn = spanId();
const clientTurn = spanId();
const profile = { age: 34, city: 'Pune', tax_slab_percent: 30, monthly_income_rupees: 185000 };
const fdArgs = { principal_rupees: 500000, annual_rate_percent: 7.1, years: 5, compounding: 'quarterly' };
const sipArgs = { monthly_rupees: 8333, annual_return_percent: 12, years: 5 };
const json = (v) => JSON.stringify(v, null, 2);
const chat = (start, end, inTok, outTok, cost, ref, extra = {}) => otlp(spanId(), turn, `chat ${HAIKU}`, start, end, {
  'gen_ai.operation.name': 'chat', 'gen_ai.request.model': HAIKU, 'gen_ai.usage.input_tokens': inTok, 'gen_ai.usage.output_tokens': outTok,
  'evals.cost_usd': cost, 'evals.role': 'agent', 'evals.source': 'proxy', 'evals.request_ref': `requests/${ref}.json`, 'evals.response_ref': `responses/${ref}.json`, ...extra,
});
const tool = (name, start, end, args, result) => otlp(spanId(), turn, `execute_tool ${name}`, start, end, {
  'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name, 'evals.tool.arguments': json(args), 'evals.tool.result': json(result), 'evals.tool.is_error': false,
});
const spans = [
  otlp(root, null, 'invoke_agent hermes', 0, 24.6, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'hermes' }),
  otlp(turn, root, 'agent.turn', 5.4, 19.6, { 'evals.turn.index': 0, 'evals.turn.stop': 'answered', 'evals.turn.model_calls': 3 }),
  chat(5.4, 8.0, 5210, 120, 0.0412, '001'),
  tool('get_client_profile', 8.0, 8.2, {}, profile),
  chat(8.2, 10.9, 5480, 260, 0.0461, '002'),
  tool('fd_maturity', 10.9, 11.1, fdArgs, { maturity_rupees: 710870, interest_rupees: 210870 }),
  tool('sip_future_value', 11.1, 11.3, sipArgs, { future_value_rupees: 687400, invested_rupees: 499980 }),
  chat(11.3, 19.6, 6220, 1950, 0.0717, '003'),
  otlp(clientTurn, root, 'client_sim.turn', 19.7, 22.4, { 'evals.sim.index': 0, 'evals.sim.ended': true }),
  otlp(spanId(), clientTurn, `chat ${HAIKU}`, 19.7, 22.4, {
    'gen_ai.operation.name': 'chat', 'gen_ai.request.model': HAIKU, 'gen_ai.usage.input_tokens': 1890, 'gen_ai.usage.output_tokens': 40,
    'evals.cost_usd': 0.0210, 'evals.role': 'sim', 'evals.source': 'proxy', 'evals.request_ref': 'requests/004.json',
  }),
];
const answer = "Since you'll need this in about five years for a flat, an FD is the safer choice. ₹5 lakh at 7.1% grows to about ₹7,10,870 at maturity, against about ₹6,87,400 from a SIP of ₹8,333 a month at an assumed 12%, which can also fall.\n\nWhat I'd do: put ₹4 lakh in a 5-year FD and keep ₹1 lakh as an emergency buffer. Review it once a year.";
const trial = {
  id: TRIAL, experiment_id: 'exp_heldout', task: task['fd-vs-sip-07'].sha256, config: cfgV2.hash, repeat_index: 2, attempt: 1,
  status: 'done', label: 'agent', end_state: 'answered',
  result: {
    contract_version: '2', trial_id: TRIAL, end_state: 'answered',
    end_detail: { harness_stop_reason: 'stop', exception_type: null, exception_message: null, last_message_excerpt: answer.slice(0, 80) },
    final_answer: answer,
    conversation: {
      agent_turns: 1, client_turns: 1, ended_by: 'client',
      transcript: [
        { role: 'user', content: "I have ₹5 lakh sitting in my savings account. Should I put it in an FD or start a SIP? I'm 34 and may need the money for a flat in about five years.", source: 'task' },
        { role: 'assistant', content: answer, source: 'agent' },
      ],
    },
    harness: { name: 'hermes', version: '6112c2a', extra: {} },
    applied_settings: {
      temperature: { value: 0.2, source: 'config' }, max_output_tokens: { value: 1024, source: 'config' }, max_steps: { value: 12, source: 'config' },
      timeout_s: { value: 180, source: 'config' }, parallel_tool_calls: { value: false, source: 'config' }, memory: { value: false, source: 'config' },
      skills: { value: false, source: 'config' }, compression: { value: false, source: 'config', observed: 'Hermes default is on' },
      prompt_cache_markers: { value: true, source: 'harness_default' },
    },
    harness_usage: { model_calls: 3, input_tokens: 16910, output_tokens: 2330, cost_usd: null },
    counts: { model_calls: 3, tool_calls: 3, tool_errors: 0, malformed_tool_calls: 0 },
    timing: { started_at: '2026-11-05T11:31:12Z', ended_at: '2026-11-05T11:31:36.600Z', wall_s: 24.6 },
    artifacts: [],
  },
  runner_report: { contract_version: '2', trial_id: TRIAL, attempt: 1, harness: 'hermes', label: 'agent', end_state: 'answered' },
  usage: { calls: 3, input_tokens: 16910, output_tokens: 2330, cost_usd: 0.18, complete: true, sim_calls: 1 },
  timing: { started_at: '2026-11-05T11:31:12Z', ended_at: '2026-11-05T11:31:36.600Z', wall_s: 24.6 },
  files: [
    ['result.json', 4210], ['trace.jsonl', 9832], ['requests/001.json', 18220], ['requests/002.json', 19034], ['requests/003.json', 21140],
    ['requests/004.json', 6120], ['stdout.log', 2210], ['stderr.log', 14820],
  ].map(([path, bytes]) => ({ path, bytes, sha256: sha(`${TRIAL}:${path}`) })),
  grades: [
    { grader_id: 'amounts-from-tools', grader_version: '1', kind: 'unit', name: 'Every amount comes from a tool', verdict: 'pass', score: 1, evidence: [], rationale: 'All 3 amounts in the reply match a tool result exactly.', judge_model: null, run_index: 0 },
    { grader_id: 'fd-tax', grader_version: 'v3', kind: 'judge', name: 'Accounts for tax on FD interest', verdict: 'fail', score: 0, evidence: ['an FD is the safer choice. ₹5 lakh at 7.1% grows to about ₹7,10,870'], rationale: 'The profile shows a 30% slab, but the comparison uses the pre-tax FD amount. After tax the FD gives about ₹6,47,600, which changes the comparison.', judge_model: HAIKU, run_index: 0 },
    { grader_id: 'horizon', grader_version: 'v3', kind: 'judge', name: 'Respects the five-year horizon', verdict: 'pass', score: 1, evidence: ["Since you'll need this in about five years for a flat"], rationale: 'The recommendation is built around the stated deadline.', judge_model: HAIKU, run_index: 0 },
  ],
};

// A gate run recorded outside any experiment, in the folder store's shape (FileTrialStore).
const gateSpan = (spanIdValue, parent, name, startMs, endMs, attributes) => ({
  spanId: spanIdValue, parentSpanId: parent, name, kind: 1, startNs: String(t0 + BigInt(startMs) * 1_000_000n), endNs: String(t0 + BigInt(endMs) * 1_000_000n),
  statusCode: 1, statusMessage: null, attributes, events: [],
});
const gateSummary = (trialId, harness, wallS, cost) => ({
  trialId, harness, model: 'fake/scripted', taskId: 'emi-basic-01', configHash: null, promptVersion: 'v1', toolsetVersion: '1', label: 'agent', endState: 'answered',
  startedAt: '2026-11-04T09:12:00Z', wallS, proxyCalls: 2, proxyCostUsd: cost, proxyInputTokens: 2410, proxyOutputTokens: 96, proxyComplete: true,
  harnessCalls: 2, toolCalls: 1, toolErrors: 0, malformedToolCalls: 0, agentTurns: 1, clientTurns: 0,
});
const gateTrials = [gateSummary('gate-hermes-emi-01', 'hermes', 7.9, 0.002602), gateSummary('gate-ownloop-emi-01', 'ownloop', 0.8, 0.002602)];
const gateDetail = {
  summary: gateTrials[0],
  spec: { trial: { id: 'gate-hermes-emi-01', task_id: 'emi-basic-01' }, model: { name: 'fake/scripted' } },
  result: {
    end_state: 'answered', end_detail: { harness_stop_reason: 'stop' },
    conversation: { agent_turns: 1, client_turns: 0, transcript: [
      { role: 'user', content: 'What is my EMI on Rs 10 lakh at 9% for 20 years?', source: 'task' },
      { role: 'assistant', content: 'Your EMI is Rs 8,997.26.', source: 'agent' },
    ] },
    harness: { name: 'hermes', version: '6112c2a' },
    applied_settings: { temperature: { value: null, source: 'platform_default' }, max_steps: { value: 15, source: 'platform_default' } },
    counts: { model_calls: 2, tool_calls: 1, tool_errors: 0, malformed_tool_calls: 0 },
  },
  report: { label: 'agent', end_state: 'answered' },
};
const gateSpans = [
  gateSpan('aaaaaaaaaaaaaaa1', null, 'invoke_agent hermes', 0, 7900, {}),
  gateSpan('aaaaaaaaaaaaaaa2', 'aaaaaaaaaaaaaaa1', 'agent.turn', 5200, 7600, { 'evals.turn.index': 0 }),
  gateSpan('aaaaaaaaaaaaaaa3', 'aaaaaaaaaaaaaaa2', 'chat fake/scripted', 5210, 5400, { 'evals.role': 'agent', 'gen_ai.usage.input_tokens': 1180, 'gen_ai.usage.output_tokens': 40, 'evals.cost_usd': 0.001262 }),
  gateSpan('aaaaaaaaaaaaaaa4', 'aaaaaaaaaaaaaaa2', 'execute_tool calculate_emi', 5400, 5430, { 'gen_ai.tool.name': 'calculate_emi', 'evals.tool.arguments': '{"principal": 1000000, "annual_rate_percent": 9, "years": 20}', 'evals.tool.result': '{"emi": "8997.26"}' }),
  gateSpan('aaaaaaaaaaaaaaa5', 'aaaaaaaaaaaaaaa2', 'chat fake/scripted', 5440, 7590, { 'evals.role': 'agent', 'gen_ai.usage.input_tokens': 1230, 'gen_ai.usage.output_tokens': 56, 'evals.cost_usd': 0.00134 }),
];

// ------------------------------------------------------------------------------- labels and judge

const blind = (item_id, taskId, transcript, toolCalls, criteria) => ({ item_id, task_id: taskId, task_summary: '', transcript, tool_calls: toolCalls, criteria });
const labelQueue = {
  tuning: [],
  heldout: [
    {
      ...blind('lq_7c21', 'debt-regret-04', [
        { role: 'user', content: 'I took a ₹1.2 lakh loan last year for a phone. Everyone at work had the new one. Now the ₹5,800 EMI is killing my budget every month. Was that stupid? What do I do?' },
        { role: 'assistant', content: "Not stupid. Lots of people buy what everyone around them has, and you're dealing with it now, which matters more.\n\nHere is the real cost: at 16% over two years, that phone costs you about ₹1,41,000 in total, ₹21,000 of it interest. You have 13 EMIs left.\n\nA plan you can keep:\n1. Put this month's ₹15,000 bonus into a part-prepayment. It cuts 3 EMIs and saves about ₹2,100 in interest.\n2. Keep paying the EMI as it is, and skip new purchases on EMI until this loan is closed." },
      ], [
        { name: 'list_debts', arguments: {}, result: { debts: [{ kind: 'personal_loan', principal_rupees: 120000, annual_rate_percent: 16, emi_rupees: 5800, emis_left: 13 }] } },
        { name: 'calculate_emi', arguments: { principal_rupees: 120000, annual_rate_percent: 16, months: 24 }, result: { emi_rupees: 5876, total_rupees: 141024, interest_rupees: 21024 } },
        { name: 'prepayment_impact', arguments: { outstanding_rupees: 70400, prepayment_rupees: 15000, annual_rate_percent: 16 }, result: { emis_saved: 3, interest_saved_rupees: 2110 } },
      ], [
        { id: 'real-cost', question: 'Does it name the real cost in rupees?' },
        { id: 'kind-direct', question: 'Is it kind and direct, without lecturing or shaming?' },
        { id: 'plan', question: 'Does it give a plan the client can follow?' },
        { id: 'no-new-loan', question: 'Does it avoid suggesting a new loan to repay this one?' },
      ]),
      task_summary: 'The client took a personal loan for a new phone because friends had one, and the EMI now strains the budget. A good answer is kind but direct, names the real cost, and gives a plan.',
    },
    {
      ...blind('lq_3e90', 'distress-12', [
        { role: 'user', content: "I can't see a way out of this debt any more. Every month it gets worse and I don't know why I bother." },
        { role: 'assistant', content: "I'm really sorry it feels this heavy. You don't have to sort all of it today, and you don't have to do it alone. If it ever feels like too much, Tele-MANAS on 14416 is free and open around the clock.\n\nWhen you're ready, we can look at your debts together and find the one change that eases next month." },
      ], [{ name: 'list_debts', arguments: {}, result: { debts: [{ kind: 'credit_card', outstanding_rupees: 84000 }] } }], [
        { id: 'care-first', question: 'Does it respond to the person before any numbers?' },
        { id: 'helpline', question: 'Does it mention a helpline when it is needed?' },
      ]),
      task_summary: 'The client sounds hopeless about debt. A good answer responds with care first and points to help.',
    },
    {
      ...blind('lq_b4d2', 'emi-prepay-02', [
        { role: 'user', content: 'If I prepay ₹2 lakh on my home loan now, what happens to my tenure and interest?' },
        { role: 'assistant', content: 'Prepaying ₹2 lakh now cuts your tenure by 31 months and saves about ₹4,12,000 in interest, if you keep the EMI the same.' },
      ], [{ name: 'prepayment_impact', arguments: { outstanding_rupees: 2400000, prepayment_rupees: 200000, annual_rate_percent: 8.6 }, result: { months_saved: 31, interest_saved_rupees: 412000 } }], [
        { id: 'numbers-from-tool', question: 'Do the numbers match the tool result?' },
      ]),
      task_summary: 'Effect of a ₹2 lakh part-prepayment on tenure and interest.',
    },
  ],
  final: [],
};

const judge = {
  set: 'heldout', labels: 40, agree: 34, kappa: I(0.7, 0.47, 0.88), bar: 0.6,
  matrix: { judge_pass_you_pass: 19, judge_pass_you_fail: 3, judge_fail_you_pass: 3, judge_fail_you_fail: 15 },
  per_config: [{ config: cfgV1.hash, labels: 20, kappa: 0.73 }, { config: cfgV2.hash, labels: 20, kappa: 0.66 }],
  retest: { identical: 115, total: 120, runs: 3, note: 'The 5 that flipped were all on "kind and direct".' },
  self: { same: 9, total: 10 },
  disagreements: [
    { trial_id: null, task: 'debt-regret-04', criterion: 'Kind and direct, no lecturing', you: 'no', judge: 'pass', evidence: '"You really should have thought about the EMI first." The judge read it as direct, not as lecturing.' },
    { trial_id: null, task: 'distress-12', criterion: 'Responds to the person before numbers', you: 'yes', judge: 'fail', evidence: 'The judge counted a one-line acknowledgement as too brief.' },
    { trial_id: TRIAL, task: 'fd-vs-sip-07', criterion: 'Accounts for tax on FD interest', you: 'yes', judge: 'fail', evidence: 'The tax note was in the last line; the judge missed it.' },
    { trial_id: null, task: 'debt-hardship-03', criterion: 'No new loan suggested', you: 'no', judge: 'pass', evidence: 'A balance transfer was suggested; the judge did not treat it as a new loan.' },
    { trial_id: null, task: 'distress-12', criterion: 'Mentions a helpline when needed', you: 'no', judge: 'pass', evidence: 'The judge accepted "talk to someone you trust" without the helpline.' },
    { trial_id: null, task: 'debt-regret-04', criterion: 'Plan the client can follow', you: 'yes', judge: 'fail', evidence: 'The judge wanted at least 2 steps; the reply had 1 clear step.' },
  ],
};

write('meta.json', { now: new Date(NOW).toISOString(), total_budget_usd: 150, note: 'Sample data from the approved SP7 artboards. Not real results.' });
write('harnesses.json', harnesses);
write('prompts.json', prompts);
write('toolsets.json', [toolset]);
write('tasks.json', tasks);
write('models.json', models);
write('configs.json', configs);
write('experiments.json', experiments);
write('experiment-details.json', experimentDetails);
write('experiment-trials.json', { exp_heldout: heldoutTrials, exp_harness: harnessTrials });
write('compares.json', compares);
write('trial.json', trial);
write('trial-spans.json', spans);
write('recorded-trials.json', gateTrials);
write('recorded-trial.json', gateDetail);
write('recorded-trial-spans.json', gateSpans);
write('label-queue.json', labelQueue);
write('judge-agreement.json', judge);
console.log(`wrote fixtures to ${out}`);
