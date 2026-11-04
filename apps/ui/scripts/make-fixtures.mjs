// Writes the UI's sample data (src/fixtures/*.json) in the shapes of apps/api/src/contract.ts
// (fixtures.spec.ts checks them against it). The numbers and words come from the approved SP7
// artboards (4 Nov); the Hermes rendered prompt and its conflict check are the platform's own
// output for `hermes, haiku, finance-advisor v1` on 4 Nov (scripts/samples/). Nothing here is a
// real trial result, and none of it is a human label: the labelling queue holds outputs to label,
// never answers. Run from apps/ui: node scripts/make-fixtures.mjs
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
const toolset = { id: 'finance', version: 'all', sha256: named('e4c1f08'), servers: [{ name: 'finance', allowed_tools: TOOLS }] };

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
// Haiku 5.5 refuses temperature (D25), so its effect check runs on Gemini Flash.
const GEMINI = 'gemini-3.8-flash';
const temperatureEffective = { [GEMINI]: { status: 'effective', evidence: 'effect check 2026-11-04' } };
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
      temperature: s(true, 'probe:2026-11-03', { native: 'temperature', default: null, observed: 'Not sent unless set', effect: temperatureEffective }),
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
      temperature: s(true, 'probe:2026-11-03', { native: 'temperature', default: null, observed: 'Not sent unless set', effect: temperatureEffective }),
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
      // The natives as workers/adk/src/adk_adapter/capabilities.json words them: long, so the
      // settings tables are drawn at the width the live API gives them.
      temperature: s(true, 'probe:2026-11-04', { native: 'generate_content_config.temperature, sent as temperature', default: null, observed: 'Not sent unless set', effect: { [GEMINI]: { status: 'inert', evidence: 'effect check 2026-11-04: no change between 0 and 1' } } }),
      max_output_tokens: pending('generate_content_config.max_output_tokens, sent as max_completion_tokens'), max_steps: pending('RunConfig.max_llm_calls, set each turn to the steps left'),
      timeout_s: watchdog, parallel_tool_calls: pending('LiteLlm(parallel_tool_calls=...), passed through to the request'),
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

// GET /harnesses adds the worker project's version and the capabilities file's hash.
for (const h of harnesses) {
  h.python = `>=${h.python}`;
  h.adapter_version = '0.1.0';
  h.capabilities_sha256 = sha(JSON.stringify(h.capabilities));
}

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
const tasks = taskList.map((t) => ({
  sha256: sha(`task:${t.id}:1`), id: t.id, version: '1', split: t.split === 'heldout' ? 'held_out' : t.split,
  kind: t.kind === 'single' ? 'single_prompt' : t.kind, summary: t.summary, graders: t.graders, problems: [],
}));
const task = Object.fromEntries(tasks.map((t) => [t.id, t]));
const heldout = tasks.filter((t) => t.split === 'held_out');
const discovery = tasks.filter((t) => t.split === 'discovery');

// ------------------------------------------------------------------------------- configs

/** MODEL_REJECTS in apps/api/src/configs/settings.ts: Claude Haiku 5.5 refuses temperature (D25). */
const MODEL_REJECTS = { [HAIKU]: { label: 'Claude Haiku 5.5', rejects: ['temperature'] } };
/** PLATFORM_DEFAULTS in apps/api/src/configs/settings.ts. */
const OFF = { enabled: false };
const PLATFORM_DEFAULTS = { temperature: null, max_output_tokens: 8192, max_steps: 15, timeout_s: 300, parallel_tool_calls: false, memory: OFF, skills: OFF, compression: OFF };
const SETTINGS = Object.keys(PLATFORM_DEFAULTS);
const harnessByName = Object.fromEntries(harnesses.map((h) => [h.name, h]));

/** What POST /configs stores for these settings: resolveSettings and unsupportedReasons in
 *  apps/api/src/configs/settings.ts, so the sample configs follow the API's own rules. */
function resolveSettings(given, harnessName, model) {
  const caps = harnessByName[harnessName].capabilities.settings;
  const rejects = MODEL_REJECTS[model]?.rejects ?? [];
  const settings = {};
  const settings_sources = {};
  const unsupported = {};
  for (const name of SETTINGS) {
    const set = given[name] !== undefined && given[name] !== null;
    if (!caps[name].supported) {
      if (set) throw new Error(`a sample config sets ${name}, which ${harnessName} does not support`);
      settings[name] = null;
      settings_sources[name] = 'unsupported';
      unsupported[name] = caps[name].observed ? `${harnessName} does not support ${name}: ${caps[name].observed}` : `${harnessName} does not support ${name}`;
      continue;
    }
    if (rejects.includes(name)) {
      if (set) throw new Error(`a sample config sets ${name}, which ${model} refuses`);
      unsupported[name] = `${MODEL_REJECTS[model].label} rejects ${name}, so it is not sent and the provider's default applies`;
    }
    if (set) {
      settings[name] = given[name];
      settings_sources[name] = 'config';
    } else if (PLATFORM_DEFAULTS[name] === null || rejects.includes(name)) {
      settings[name] = null;
      settings_sources[name] = 'harness_default';
    } else {
      settings[name] = PLATFORM_DEFAULTS[name];
      settings_sources[name] = 'platform_default';
    }
  }
  return { settings, settings_sources, unsupported };
}

const promptRef = (p) => ({ id: p.id, version: p.version, sha256: p.sha256 });
const toolsetRef = { id: toolset.id, version: toolset.version, sha256: toolset.sha256 };
const [v2, v1] = prompts;
const makeConfig = ({ hash, name, harness, model, prompt, settings, parent = null, minutesAgo }) => {
  const h = harnessByName[harness];
  return {
    hash, name, harness, harness_ref: h.ref, adapter_version: h.adapter_version, capabilities_sha256: h.capabilities_sha256, model,
    prompt: promptRef(prompt), toolset: toolsetRef, ...resolveSettings(settings, harness, model), warnings: [], harness_options: {}, seed: { memory: [], skills: [] },
    parent_hash: parent, created_at: at(minutesAgo),
  };
};
// Haiku 5.5 refuses temperature, so no sample config on it sets one (D25).
const baseSettings = { max_output_tokens: 1024, max_steps: 12, timeout_s: 180, parallel_tool_calls: false, memory: OFF, skills: OFF, compression: OFF };
const ownSettings = { max_output_tokens: 1024, max_steps: 12, timeout_s: 180, parallel_tool_calls: false };
const cfgV1 = makeConfig({ hash: named('3b81e04'), name: 'Prompt v1 on Hermes', harness: 'hermes', model: HAIKU, prompt: v1, settings: baseSettings, minutesAgo: 3 * 1440 });
// Forked from v1 with only the prompt changed (D34).
const cfgV2 = makeConfig({ hash: named('7f3a9c2'), name: 'Prompt v2 on Hermes', harness: 'hermes', model: HAIKU, prompt: v2, settings: baseSettings, parent: cfgV1.hash, minutesAgo: 2 * 1440 + 200 });
const cfgOwn = makeConfig({ hash: named('a91c4d0'), name: 'Own loop, prompt v1', harness: 'ownloop', model: HAIKU, prompt: v1, settings: ownSettings, minutesAgo: 1440 + 300 });
// Forked from v1 with only the model changed.
const cfgGemini = makeConfig({ hash: named('c58e2d1'), name: 'Prompt v1 on Hermes, Gemini Flash', harness: 'hermes', model: 'gemini-3.8-flash', prompt: v1, settings: baseSettings, parent: cfgV1.hash, minutesAgo: 400 });
/** GET /configs lists the oldest first. */
const configs = [cfgV1, cfgV2, cfgOwn, cfgGemini];
const children = (c) => configs.filter((x) => x.parent_hash === c.hash).map((x) => ({ hash: x.hash, name: x.name, created_at: x.created_at }));
const configDetails = Object.fromEntries(configs.map((c) => [c.hash, { ...c, children: children(c) }]));

// ------------------------------------------------------------------------------- experiments

/** The claim order (D32), as apps/api/src/experiments/order.ts draws it from a seed. */
const seededRandom = (seed) => {
  let i = 0;
  return () => createHash('sha256').update(`${seed}:${i++}`).digest().readUInt32BE(0) / 2 ** 32;
};
const shuffle = (items, rand) => {
  const outItems = [...items];
  for (let i = outItems.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [outItems[i], outItems[j]] = [outItems[j], outItems[i]];
  }
  return outItems;
};
const claimOrder = (taskList_, cfgs, n, seed) => {
  const rand = seededRandom(seed);
  const blocks = [];
  for (let repeat = 0; repeat < n; repeat += 1) for (const t of taskList_) blocks.push({ task: t, repeat });
  return shuffle(blocks, rand).flatMap((b) => shuffle(cfgs.map((c, arm) => ({ c, arm })), rand).map(({ c, arm }) => ({ task: b.task, cfg: c, arm, repeat: b.repeat })));
};

const LETTERS = ['A', 'B', 'C'];
const jitter = (i, spread) => ((i * 7919) % 100) / 100 * spread - spread / 2;
/** One GET /experiments/:id/trials row. `passed` is the UI's (not in the contract): pass or fail
 *  once graded, so the sample run grid can show both. */
const trialRow = (expId, id, slot, orderIndex, attempt, status, label, passed, i, minutesAgo) => {
  const finished = ['done', 'infra_failed', 'abandoned'].includes(status);
  const claimed = finished || status === 'running' || status === 'claimed';
  const a = slot.arm === 0;
  return {
    id, experiment_id: expId, task_sha256: slot.task.sha256, task_id: slot.task.id, config_hash: slot.cfg.hash, config_name: slot.cfg.name,
    harness: slot.cfg.harness, model: slot.cfg.model, repeat_index: slot.repeat, order_index: orderIndex, arm: LETTERS[slot.arm], attempt, status, label,
    end_state: status === 'done' ? 'answered' : null,
    cost_usd: status === 'done' || status === 'infra_failed' ? Number(((a ? 0.15 : 0.16) + jitter(i, 0.06)).toFixed(4)) : null,
    input_tokens: status === 'done' ? Math.round((a ? 16000 : 16600) + jitter(i, 3000)) : null,
    output_tokens: status === 'done' ? Math.round((a ? 2200 : 2300) + jitter(i, 600)) : null,
    model_calls: status === 'done' ? 3 : null,
    wall_s: status === 'done' ? Number(((a ? 41 : 43) + jitter(i, 14)).toFixed(1)) : null,
    worker_id: claimed ? `${slot.cfg.harness}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}` : null,
    claimed_at: claimed ? at(minutesAgo + 1) : null,
    finished_at: finished ? at(minutesAgo) : null,
    passed: status === 'done' ? passed : null,
  };
};
/** The API lists trial rows in plan order: repeat, task, config, then attempt. */
const planOrder = (taskList_, cfgs) => (x, y) =>
  x.repeat_index - y.repeat_index ||
  taskList_.findIndex((t) => t.sha256 === x.task_sha256) - taskList_.findIndex((t) => t.sha256 === y.task_sha256) ||
  cfgs.findIndex((c) => c.hash === x.config_hash) - cfgs.findIndex((c) => c.hash === y.config_hash) ||
  x.attempt - y.attempt;

const zero = () => ({ queued: 0, running: 0, done: 0, infra_failed: 0, abandoned: 0, cancelled: 0 });
const countsOf = (trials) => {
  const c = { ...zero(), by_label: {}, done_by_end_state: {} };
  for (const t of trials) {
    c[t.status === 'claimed' ? 'running' : t.status] += 1;
    if (t.label) c.by_label[t.label] = (c.by_label[t.label] ?? 0) + 1;
    if (t.status === 'done' && t.end_state) c.done_by_end_state[t.end_state] = (c.done_by_end_state[t.end_state] ?? 0) + 1;
  }
  return c;
};
const plainCounts = (done) => ({ ...zero(), done, by_label: { agent: done }, done_by_end_state: { answered: done } });

const armOf = (letter, cfg, trials, status, extra = {}) => {
  const counts = zero();
  for (const t of trials.filter((x) => x.config_hash === cfg.hash)) counts[t.status === 'claimed' ? 'running' : t.status] += 1;
  return { arm: letter, config_hash: cfg.hash, config_name: cfg.name, status, paused_at: null, paused_reason: null, fix: null, counts, reused_from: null, reused_trials: 0, ...extra };
};
const doneArm = (letter, cfg, done) => ({ ...armOf(letter, cfg, [], 'complete'), counts: { ...zero(), done } });

const PRICES = { [HAIKU]: { input_per_mtok: 0.1, output_per_mtok: 0.5 }, 'gemini-3.8-flash': { input_per_mtok: 0.75, output_per_mtok: 3.75 } };
const ASSUMPTIONS = { input_tokens_per_trial: 64000, output_tokens_per_trial: 2400, wall_s_per_trial: 60, sim_input_tokens_per_call: 2000, sim_output_tokens_per_call: 150, low_factor: 0.5, high_factor: 2 };
const estimate = (trials, expected, low, high, minutes, workers, basis = 'Tokens per trial: the mean of earlier finished trials of the same config and task for every cell. Prices: LiteLLM /model/info. Range: 0.5x to 2x the expected cost. Time: each harness divides its trials by its live workers, harnesses in parallel.') => ({
  trials, cost_usd: { expected, low, high }, minutes, basis,
  basis_detail: { cells: [], prices: PRICES, assumptions: ASSUMPTIONS, workers },
  budgets: { trial_usd: 0.5, sim_usd: 0.1 },
});
const FUTILITY = { enabled: true, after: 3, min_passed: 1 };
const exp = (o) => ({
  task_sha256s: [], budget_usd: 40, created_at: at(0), sim_model: HAIKU,
  sim: { prompt: { id: 'client-sim', version: 'v3', sha256: named('44ac8b0') }, temperature: null, max_output_tokens: 2048 },
  platform_commit: 'c4d2e19', plan_commit: '3e1a9f0', budgets: { trial_usd: 0.5, sim_usd: 0.1 },
  started_at: null, finished_at: null, paused_at: null, paused_reason: null,
  order_seed: null, futility: FUTILITY, parent_experiment_id: null, baseline: null, actual: null, arms: [], judge: null, example: null, ...o,
});
const ev = (minutesAgo, kind, detail, extra = {}) => ({ at: at(minutesAgo), kind, trial_id: null, attempt: null, arm: null, config_hash: null, detail, ...extra });
const where = (t) => `${t.task_id} on ${t.config_name}, attempt ${t.attempt}`;

// Held-out prompt experiment (done): per-task pass counts from the compare artboard.
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
const tid = (taskId, arm, repeat, attempt = 1) => `tr_${taskId}_${arm}_${repeat + 1}${attempt > 1 ? `_attempt${attempt}` : ''}`;
const HELDOUT_SEED = 1105;
const heldoutTrials = [];
{
  const order = claimOrder(heldout, [cfgV1, cfgV2], 5, HELDOUT_SEED);
  let k = 0;
  order.forEach((slot, orderIndex) => {
    const arm = slot.arm === 0 ? 'a' : 'b';
    const ti = heldout.indexOf(slot.task);
    let pattern = passPattern(heldoutCounts[slot.task.id][slot.arm], ti + slot.arm);
    if (slot.task.id === 'fd-vs-sip-07' && arm === 'b') pattern = [true, true, false, false, false];
    const p = pattern[slot.repeat];
    const ago = 165 - Math.round((orderIndex / order.length) * 44);
    const infra = arm === 'b' && slot.repeat === 1 && (slot.task.id === 'debt-hardship-03' || slot.task.id === 'fd-vs-sip-07');
    if (infra) {
      heldoutTrials.push(trialRow('exp_heldout', tid(slot.task.id, arm, slot.repeat), slot, orderIndex, 1, 'infra_failed', 'infra:provider_error', null, k++, ago));
      heldoutTrials.push(trialRow('exp_heldout', tid(slot.task.id, arm, slot.repeat, 2), slot, orderIndex, 2, 'done', 'agent', p, k++, ago - 1));
    } else {
      heldoutTrials.push(trialRow('exp_heldout', tid(slot.task.id, arm, slot.repeat), slot, orderIndex, 1, 'done', 'agent', p, k++, ago));
    }
  });
  heldoutTrials.sort(planOrder(heldout, [cfgV1, cfgV2]));
}

// The running harness experiment: the first 62 slots in claim order are claimed and finished (60
// done; two arm-B slots stopped by a provider error, each re-queued as attempt 2), the next 4 run
// (two workers per harness) and the other 54 wait.
const HARNESS_SEED = 2024;
const HARNESS_CLAIMED = 62;
const HARNESS_RUNNING = 4;
const harnessTrials = [];
const harnessEvents = [];
{
  const order = claimOrder(heldout, [cfgOwn, cfgV1], 5, HARNESS_SEED);
  const bClaimed = order.map((s, i) => ({ s, i })).filter(({ s, i }) => s.arm === 1 && i < HARNESS_CLAIMED);
  const infraAt = new Set([bClaimed[13].i, bClaimed[23].i]);
  let k = 0;
  order.forEach((slot, orderIndex) => {
    const arm = slot.arm === 0 ? 'a' : 'b';
    const id = `th_${slot.task.id}_${arm}_${slot.repeat + 1}`;
    const ago = 27 - Math.round((orderIndex / HARNESS_CLAIMED) * 26);
    if (orderIndex < HARNESS_CLAIMED) {
      if (infraAt.has(orderIndex)) {
        const first = trialRow('exp_harness', id, slot, orderIndex, 1, 'infra_failed', 'infra:provider_error', null, k++, ago);
        harnessTrials.push(first, trialRow('exp_harness', `${id}_attempt2`, slot, orderIndex, 2, 'queued', null, null, k++, ago));
        harnessEvents.push(
          ev(ago, 'infra_failure', `${where(first)}: infra:provider_error (LiteLLM status 429): rate limited`, { trial_id: first.id, attempt: 1, arm: 'B', config_hash: cfgV1.hash }),
          ev(ago, 'requeue', `${slot.task.id} on ${cfgV1.name}, attempt 2 queued`, { trial_id: `${id}_attempt2`, attempt: 2, arm: 'B', config_hash: cfgV1.hash }),
        );
      } else {
        const p = seededRandom(orderIndex + 77)() < (arm === 'a' ? 0.55 : 0.68);
        harnessTrials.push(trialRow('exp_harness', id, slot, orderIndex, 1, 'done', 'agent', p, k++, ago));
      }
    } else if (orderIndex < HARNESS_CLAIMED + HARNESS_RUNNING) {
      harnessTrials.push(trialRow('exp_harness', id, slot, orderIndex, 1, 'running', null, null, k++, 0));
    } else {
      harnessTrials.push(trialRow('exp_harness', id, slot, orderIndex, 1, 'queued', null, null, k++, 0));
    }
  });
  harnessTrials.sort(planOrder(heldout, [cfgOwn, cfgV1]));
}

// A model experiment whose arm B hit a config error (D37): only arm B pauses; arm A runs on.
const MODEL_SEED = 31;
const modelTasks = discovery.slice(0, 4);
const modelTrials = [];
let modelErrorTrial = null;
{
  const order = claimOrder(modelTasks, [cfgV1, cfgGemini], 3, MODEL_SEED);
  let bSeen = 0;
  let k = 0;
  let aClaims = 0;
  order.forEach((slot, orderIndex) => {
    const arm = slot.arm === 0 ? 'a' : 'b';
    const id = `tm_${slot.task.id}_${arm}_${slot.repeat + 1}`;
    if (arm === 'b') {
      bSeen += 1;
      if (bSeen === 1) modelTrials.push(trialRow('exp_model', id, slot, orderIndex, 1, 'done', 'agent', true, k++, 9));
      else if (bSeen === 2) {
        modelErrorTrial = trialRow('exp_model', id, slot, orderIndex, 1, 'infra_failed', 'infra:config_error', null, k++, 7);
        modelErrorTrial.cost_usd = 0;
        modelTrials.push(modelErrorTrial);
      } else modelTrials.push(trialRow('exp_model', id, slot, orderIndex, 1, 'queued', null, null, k++, 0));
      return;
    }
    aClaims += 1;
    const status = aClaims <= 5 ? 'done' : aClaims <= 7 ? 'running' : 'queued';
    modelTrials.push(trialRow('exp_model', id, slot, orderIndex, 1, status, status === 'done' ? 'agent' : null, aClaims % 3 !== 0, k++, 10 - aClaims));
  });
  modelTrials.sort(planOrder(modelTasks, [cfgV1, cfgGemini]));
}
const modelArmReason = `trial ${modelErrorTrial.id} (${where(modelErrorTrial)}): infra:config_error (LiteLLM status 404): litellm.NotFoundError: model 'gemini-3.8-flash' is not served by this proxy`;
const modelArmFix =
  "The provider does not know the model: fix the model's route in LiteLLM's config, then POST /experiments/:id/arms/:config_hash/resume to continue this arm; if the config names the wrong model, fork it with the right one and run a new experiment.";

// A prompt experiment the futility check paused (D32): arm B passed none of its first 3 trials.
const FUTILITY_SEED = 404;
const futilityTasks = discovery.slice(8, 12);
const futilityTrials = [];
{
  const order = claimOrder(futilityTasks, [cfgV1, cfgV2], 5, FUTILITY_SEED);
  let k = 0;
  order.forEach((slot, orderIndex) => {
    const arm = slot.arm === 0 ? 'a' : 'b';
    const id = `tf_${slot.task.id}_${arm}_${slot.repeat + 1}`;
    const done = orderIndex < 6;
    futilityTrials.push(trialRow('exp_futility', id, slot, orderIndex, 1, done ? 'done' : 'queued', done ? 'agent' : null, arm === 'a' ? orderIndex !== 2 : false, k++, done ? 20 - orderIndex : 0));
  });
  futilityTrials.sort(planOrder(futilityTasks, [cfgV1, cfgV2]));
}
const futilityReason =
  'futility check (D32): arm B passed 0 of its first 3 finished trials, fewer than the 1 the rule asks for (passed means label agent and end state answered until graders exist (SP4)). Review those trials, then resume or stop; the check runs once per arm and never compares the arms';

const spendOf = (trials) => Number(trials.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0).toFixed(4));
const actualOf = (trials, elapsed) => {
  const finished = trials.filter((t) => ['done', 'infra_failed', 'abandoned'].includes(t.status));
  const priced = finished.filter((t) => t.cost_usd !== null);
  const walls = finished.filter((t) => t.wall_s !== null);
  const spent = spendOf(trials);
  const per = priced.length ? spent / priced.length : null;
  const left = trials.filter((t) => t.status === 'queued' || t.status === 'running').length;
  return {
    finished_trials: finished.length, spend_usd: spent, cost_per_trial_usd: per === null ? null : Number(per.toFixed(4)),
    wall_s_per_trial: walls.length ? Number((walls.reduce((s, t) => s + t.wall_s, 0) / walls.length).toFixed(1)) : null,
    elapsed_minutes: elapsed, projected_spend_usd: Number((spent + left * (per ?? 0)).toFixed(4)),
  };
};

const experiments = [
  exp({
    id: 'exp_model', name: 'Model: Haiku 5.5 vs Gemini 3.8 Flash, discovery', axis: 'model', status: 'running', config_hashes: [cfgV1.hash, cfgGemini.hash], n: 3,
    counts: countsOf(modelTrials), spend_usd: spendOf(modelTrials), estimate: estimate(24, 4.1, 2.05, 8.2, 12, { hermes: { live: 2, used: 2 } }),
    budget_usd: 20, created_at: at(12), started_at: at(11), task_sha256s: modelTasks.map((t) => t.sha256), order_seed: MODEL_SEED,
    arms: [armOf('A', cfgV1, modelTrials, 'active'), armOf('B', cfgGemini, modelTrials, 'paused', { paused_at: at(7), paused_reason: modelArmReason, fix: modelArmFix })],
    actual: actualOf(modelTrials, 11),
    events: [
      ev(7, 'arm_paused', modelArmReason, { trial_id: modelErrorTrial.id, attempt: 1, arm: 'B', config_hash: cfgGemini.hash }),
      ev(7, 'config_error', `${where(modelErrorTrial)}: infra:config_error (LiteLLM status 404): litellm.NotFoundError: model 'gemini-3.8-flash' is not served by this proxy`, { trial_id: modelErrorTrial.id, attempt: 1, arm: 'B', config_hash: cfgGemini.hash }),
      ev(11, 'started', 'trials can be claimed'),
      ev(12, 'created', `2 configs x ${modelTasks.length} tasks x N=3; claim order seed ${MODEL_SEED}`),
    ],
  }),
  exp({
    id: 'exp_futility', name: 'Prompt v1 vs v2, discovery batch 3', axis: 'prompt', status: 'paused', config_hashes: [cfgV1.hash, cfgV2.hash], n: 5,
    counts: countsOf(futilityTrials), spend_usd: spendOf(futilityTrials), estimate: estimate(40, 6.4, 3.2, 12.8, 22, { hermes: { live: 2, used: 2 } }),
    budget_usd: 20, created_at: at(25), started_at: at(24), paused_at: at(14), paused_reason: futilityReason, task_sha256s: futilityTasks.map((t) => t.sha256),
    order_seed: FUTILITY_SEED, parent_experiment_id: 'exp_discovery',
    arms: [armOf('A', cfgV1, futilityTrials, 'active'), armOf('B', cfgV2, futilityTrials, 'active')],
    actual: actualOf(futilityTrials, 10),
    events: [
      ev(14, 'futility_pause', futilityReason),
      ev(24, 'started', 'trials can be claimed'),
      ev(25, 'created', `2 configs x ${futilityTasks.length} tasks x N=5; claim order seed ${FUTILITY_SEED}`),
    ],
  }),
  exp({
    id: 'exp_harness', name: 'Harness: own loop vs Hermes', axis: 'harness', status: 'running', config_hashes: [cfgOwn.hash, cfgV1.hash], n: 5,
    counts: countsOf(harnessTrials), spend_usd: 11.2, estimate: estimate(120, 21.3, 16, 27, 38, { ownloop: { live: 2, used: 2 }, hermes: { live: 2, used: 2 } }),
    created_at: at(30), started_at: at(27), task_sha256s: heldout.map((t) => t.sha256), order_seed: HARNESS_SEED,
    arms: [armOf('A', cfgOwn, harnessTrials, 'active'), armOf('B', cfgV1, harnessTrials, 'active')],
    actual: { ...actualOf(harnessTrials, 27), spend_usd: 11.2, projected_spend_usd: 21.8 },
    events: [
      ...harnessEvents.sort((x, y) => Date.parse(y.at) - Date.parse(x.at)),
      ev(27, 'started', 'trials can be claimed'),
      ev(30, 'created', `2 configs x ${heldout.length} tasks x N=5; claim order seed ${HARNESS_SEED}`),
    ],
  }),
  exp({
    id: 'exp_heldout', name: 'Prompt v1 vs v2, held-out', axis: 'prompt', status: 'done', config_hashes: [cfgV1.hash, cfgV2.hash], n: 5,
    counts: countsOf(heldoutTrials), spend_usd: 18.4, estimate: estimate(120, 21.3, 16, 27, 38, { hermes: { live: 4, used: 4 } }),
    created_at: at(170), started_at: at(165), finished_at: at(120), task_sha256s: heldout.map((t) => t.sha256), order_seed: HELDOUT_SEED,
    parent_experiment_id: 'exp_discovery',
    arms: [armOf('A', cfgV1, heldoutTrials, 'complete'), armOf('B', cfgV2, heldoutTrials, 'complete')],
    actual: { ...actualOf(heldoutTrials, 45), spend_usd: 18.4, projected_spend_usd: 18.4 },
    events: [
      ev(120, 'finished', 'every trial has finished'),
      ...heldoutTrials
        .filter((t) => t.status === 'infra_failed')
        .flatMap((t) => [
          ev(140, 'requeue', `${t.task_id} on ${t.config_name}, attempt 2 queued`, { trial_id: `${t.id}_attempt2`, attempt: 2, arm: t.arm, config_hash: t.config_hash }),
          ev(140, 'infra_failure', `${where(t)}: infra:provider_error (LiteLLM status 529): overloaded`, { trial_id: t.id, attempt: 1, arm: t.arm, config_hash: t.config_hash }),
        ]),
      ev(165, 'started', 'trials can be claimed'),
      ev(170, 'created', `2 configs x ${heldout.length} tasks x N=5; claim order seed ${HELDOUT_SEED}`),
    ],
  }),
  exp({
    id: 'exp_discovery', name: 'Prompt v1 vs v2, discovery', axis: 'prompt', status: 'done', config_hashes: [cfgV1.hash, cfgV2.hash], n: 5,
    counts: plainCounts(80), spend_usd: 12.1, estimate: estimate(80, 14, 10.5, 18, 26, { hermes: { live: 4, used: 4 } }), created_at: at(1500), started_at: at(1495), finished_at: at(1460),
    task_sha256s: discovery.slice(0, 8).map((t) => t.sha256), arms: [doneArm('A', cfgV1, 40), doneArm('B', cfgV2, 40)],
    events: [ev(1460, 'finished', 'every trial has finished'), ev(1495, 'started', 'trials can be claimed'), ev(1500, 'created', '2 configs x 8 tasks x N=5')],
  }),
  exp({
    id: 'exp_aa', name: 'A/A check, Hermes', axis: 'none', status: 'done', config_hashes: [cfgV1.hash, cfgV1.hash], n: 5,
    counts: plainCounts(100), spend_usd: 9.1, estimate: estimate(100, 10.4, 7.8, 13.2, 32, { hermes: { live: 4, used: 4 } }), created_at: at(1620), started_at: at(1615), finished_at: at(1570),
    task_sha256s: heldout.slice(0, 10).map((t) => t.sha256), arms: [doneArm('A', cfgV1, 50), doneArm('B', cfgV1, 50)],
    events: [ev(1570, 'finished', 'every trial has finished'), ev(1615, 'started', 'trials can be claimed'), ev(1620, 'created', '2 configs x 10 tasks x N=5')],
  }),
  exp({
    id: 'exp_pilot', name: 'Pilot on Haiku 5.5', axis: 'none', status: 'done', config_hashes: [cfgV1.hash], n: 5,
    counts: plainCounts(40), spend_usd: 3.3, estimate: estimate(40, 4, 3, 5.2, 14, { hermes: { live: 4, used: 4 } }, 'Tokens per trial: the docs/cost.md assumptions (64k input, 2.4k output per trial) for all 8 config x task cells. Prices: LiteLLM /model/info. Range: 0.5x to 2x the expected cost.'),
    created_at: at(2950), started_at: at(2945), finished_at: at(2900), task_sha256s: discovery.slice(0, 8).map((t) => t.sha256), arms: [doneArm('A', cfgV1, 40)],
    events: [ev(2900, 'finished', 'every trial has finished'), ev(2945, 'started', 'trials can be claimed'), ev(2950, 'created', '1 configs x 8 tasks x N=5')],
  }),
];

/** Per task and arm, from the trial rows: agent-labelled trials, graded and passed. */
const rowsFrom = (trials, cfgs) => {
  const rows = [];
  const seen = new Map();
  for (const t of trials) {
    const key = `${t.task_sha256}|${t.config_hash}`;
    if (!seen.has(key)) {
      const row = { task: t.task_sha256, task_id: t.task_id, arm: t.arm, config: t.config_hash, config_name: t.config_name, passed: 0, graded: 0, trials: 0, infra_failed: 0, abandoned: 0 };
      seen.set(key, row);
      rows.push(row);
    }
    const row = seen.get(key);
    if (t.status === 'infra_failed') row.infra_failed += 1;
    if (t.status === 'abandoned') row.abandoned += 1;
    if (t.status !== 'done' || t.label !== 'agent') continue;
    row.trials += 1;
    if (t.passed !== null) {
      row.graded += 1;
      if (t.passed) row.passed += 1;
    }
  }
  return cfgs ? rows : rows;
};
const fixedRows = (taskList_, cfgs, passedByArm) =>
  taskList_.flatMap((t, i) =>
    cfgs.map((c, arm) => ({ task: t.sha256, task_id: t.id, arm: LETTERS[arm], config: c.hash, config_name: c.name, passed: passedByArm[arm][i], graded: 5, trials: 5, infra_failed: 0, abandoned: 0 })),
  );

const I = (estimate_, low, high) => ({ estimate: estimate_, low, high });
const heldoutTaskStats = [
  ['distress-12', 80, 40, 100, true], ['debt-hardship-03', 60, 20, 100, true], ['debt-regret-04', 40, -10, 90, false],
  ['scam-otp-10', 20, -30, 70, false], ['afford-car-06', 20, -30, 70, false], ['emi-prepay-02', 20, -20, 60, false],
  ['profile-gap-11', 0, -50, 50, false], ['emi-basic-01', 0, -20, 20, false], ['sip-goal-05', 0, -40, 40, false],
  ['inflation-09', 0, -50, 50, false], ['payoff-order-08', -20, -70, 30, false], ['fd-vs-sip-07', -40, -90, 10, false],
].map(([id, d, lo, hi, significant]) => ({ task: task[id].sha256, diff: I(d, lo, hi), significant }));

const byId = Object.fromEntries(experiments.map((e) => [e.id, e]));
const complete = (id, rows, stats) => ({ experiment_id: id, status: 'complete', reason: null, arms: byId[id].arms, rows, stats });
const incomplete = (id, reason) => ({ experiment_id: id, status: 'incomplete', reason, arms: byId[id].arms, rows: [], stats: null });
const queuedOrRunning = (trials, letter) => trials.filter((t) => t.arm === letter && (t.status === 'queued' || t.status === 'running')).length;
const compares = {
  exp_heldout: complete('exp_heldout', rowsFrom(heldoutTrials), {
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
  }),
  exp_discovery: complete('exp_discovery', fixedRows(discovery.slice(0, 8), [cfgV1, cfgV2], [[3, 2, 4, 1, 3, 2, 5, 2], [4, 3, 4, 2, 4, 2, 5, 3]]), {
    measure: 'pass_rate', level: 0.95, a: { rate: 22 / 40, passed: 22, graded: 40 }, b: { rate: 27 / 40, passed: 27, graded: 40 },
    diff: I(11, -1, 23), p_value: 0.09, method: 'paired_task_bootstrap', verdict: 'no_clear_difference',
    tasks: discovery.slice(0, 8).map((t, i) => {
      const d = [20, 20, 0, 20, 20, 0, 0, 20][i];
      return { task: t.sha256, diff: I(d, d - 50, d + 50), significant: false };
    }),
    correction: 'holm', aa: { experiment_id: 'exp_aa', diff: I(1, -7, 9) }, costs: [], judge: null,
  }),
  exp_aa: complete('exp_aa', fixedRows(heldout.slice(0, 10), [cfgV1, cfgV1], [[1, 2, 2, 3, 3, 4, 2, 5, 4, 2], [2, 2, 1, 3, 4, 4, 2, 5, 4, 2]]), {
    measure: 'pass_rate', level: 0.95, a: { rate: 28 / 50, passed: 28, graded: 50 }, b: { rate: 29 / 50, passed: 29, graded: 50 },
    diff: I(1, -7, 9), p_value: 0.82, method: 'paired_task_bootstrap', verdict: 'no_clear_difference',
    tasks: heldout.slice(0, 10).map((t) => ({ task: t.sha256, diff: I(0, -40, 40), significant: false })),
    correction: 'holm', aa: null, costs: [], judge: null,
  }),
  exp_pilot: complete('exp_pilot', fixedRows(discovery.slice(0, 8), [cfgV1], [[3, 2, 4, 1, 3, 2, 5, 2]]), null),
  exp_harness: incomplete('exp_harness', `arm A has ${queuedOrRunning(harnessTrials, 'A')} trials queued or running; arm B has ${queuedOrRunning(harnessTrials, 'B')} trials queued or running`),
  exp_model: incomplete('exp_model', `arm B is paused: ${modelArmReason}`),
  exp_futility: incomplete('exp_futility', `the experiment is paused: ${futilityReason}`),
};

const configByHash = Object.fromEntries(configs.map((c) => [c.hash, c]));
const SUMMARY_KEYS = ['id', 'name', 'axis', 'status', 'config_hashes', 'task_sha256s', 'n', 'counts', 'spend_usd', 'estimate', 'budget_usd', 'created_at', 'example'];
const experimentSummaries = experiments.map((e) => Object.fromEntries(SUMMARY_KEYS.map((k) => [k, e[k]])));
const experimentDetails = Object.fromEntries(experiments.map((e) => [e.id, {
  ...e,
  tasks: e.task_sha256s.map((h) => tasks.find((t) => t.sha256 === h)),
  configs: [...new Set(e.config_hashes)].map((h) => configByHash[h]),
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
const trialTask = task['fd-vs-sip-07'];
const trialRowFor = heldoutTrials.find((t) => t.id === TRIAL);
const trial = {
  id: TRIAL, experiment_id: 'exp_heldout', probe: false,
  task: { sha256: trialTask.sha256, id: trialTask.id, version: trialTask.version, split: trialTask.split, kind: trialTask.kind, summary: trialTask.summary },
  config: { hash: cfgV2.hash, name: cfgV2.name, harness: cfgV2.harness, harness_ref: cfgV2.harness_ref, model: cfgV2.model, prompt: cfgV2.prompt, toolset: cfgV2.toolset },
  repeat_index: 2, attempt: 1, status: 'done', label: 'agent', end_state: 'answered',
  spec: { contract_version: '2', trial: { id: TRIAL, experiment_id: 'exp_heldout', task_id: trialTask.id, task_split: trialTask.split }, model: { name: HAIKU } },
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
      temperature: { value: null, source: 'harness_default', observed: 'not sent: Claude Haiku 5.5 rejects temperature' }, max_output_tokens: { value: 1024, source: 'config' },
      max_steps: { value: 12, source: 'config' }, timeout_s: { value: 180, source: 'config' }, parallel_tool_calls: { value: false, source: 'config' },
      memory: { value: OFF, source: 'config' }, skills: { value: OFF, source: 'config' }, compression: { value: OFF, source: 'config', observed: 'Hermes default is on' },
      prompt_cache_markers: { value: false, source: 'config' },
    },
    harness_usage: { model_calls: 3, input_tokens: 16910, output_tokens: 2330, cost_usd: null },
    counts: { model_calls: 3, tool_calls: 3, tool_errors: 0, malformed_tool_calls: 0 },
    timing: { started_at: '2026-11-05T11:31:12Z', ended_at: '2026-11-05T11:31:36.600Z', wall_s: 24.6 },
    artifacts: [],
  },
  runner_report: { contract_version: '2', trial_id: TRIAL, attempt: 1, harness: 'hermes', label: 'agent', end_state: 'answered' },
  usage: { model_calls: 3, input_tokens: 16910, output_tokens: 2330, cost_usd: 0.18, sim_cost_usd: 0.021, complete: true },
  timing: {
    created_at: at(165), claimed_at: trialRowFor.claimed_at, heartbeat_at: '2026-11-05T11:31:32Z', finished_at: trialRowFor.finished_at,
    started_at: '2026-11-05T11:31:12Z', ended_at: '2026-11-05T11:31:36.600Z', wall_s: 24.6,
  },
  worker_id: trialRowFor.worker_id,
  files: [
    ['result.json', 4210], ['trace.jsonl', 9832], ['checks.json', 1320], ['requests/001.json', 18220], ['requests/002.json', 19034], ['requests/003.json', 21140],
    ['requests/004.json', 6120], ['stdout.log', 2210], ['stderr.log', 14820],
  ].map(([path, bytes]) => ({ ok: true, path, bytes, sha256: sha(`${TRIAL}:${path}`) })),
  // Grades in the SP4 shape (docs/proposals/grader-format.md): a verdict, a reason, and evidence
  // quoted verbatim from its source. The judge's two are the SP5 design: on the API today the judge
  // is not built, and its grades say not_implemented.
  grades: [
    {
      id: 101, grader_id: 'fd-maturity', grader_version: sha('grader:fd-maturity:1'), kind: 'exact', type: 'number', required: true,
      verdict: 'pass', score: 1, reason: 'found ₹7,10,870, within ±1 of 710870 (fd_maturity maturity_rupees)',
      evidence: [
        { source: 'final_answer', quote: '₹7,10,870' },
        { source: 'tool_result', tool: 'fd_maturity', field: 'maturity_rupees', quote: '"maturity_rupees": 710870' },
      ],
      judge_model: null, run_index: 0, created_at: at(118),
    },
    {
      id: 102, grader_id: 'fd-tax', grader_version: sha('rubric:fd-tax:v3'), kind: 'judge', type: 'judge', required: true, verdict: 'fail', score: 0,
      reason: 'The profile shows a 30% slab, but the comparison uses the pre-tax FD amount. After tax the FD gives about ₹6,47,600, which changes the comparison.',
      evidence: [{ source: 'final_answer', quote: 'an FD is the safer choice. ₹5 lakh at 7.1% grows to about ₹7,10,870' }],
      judge_model: HAIKU, run_index: 0, created_at: at(118),
    },
    {
      id: 103, grader_id: 'horizon', grader_version: sha('rubric:horizon:v3'), kind: 'judge', type: 'judge', required: true, verdict: 'pass', score: 1,
      reason: 'The recommendation is built around the stated deadline.',
      evidence: [{ source: 'final_answer', quote: "Since you'll need this in about five years for a flat" }],
      judge_model: HAIKU, run_index: 0, created_at: at(118),
    },
  ],
  grading: {
    current: {
      job_id: 'gj_fd_b_3', status: 'done', reason: 'trial_done', grader_source: 'catalogue', source_note: null, task_sha256: task['fd-vs-sip-07'].sha256,
      framework_version: '0.1.0', passed: false, outcome: 'fail', error: null, queued_at: at(119), graded_at: at(118),
    },
    pending: null,
  },
  problems: [],
};

/** checks.json's number-provenance check, in the shape the provenance grader reads first
 *  (docs/assumptions.md A14): the amounts with no source, and how many amounts it looked at. */
const checks = {
  number_provenance: {
    total: 8,
    unsupported: [
      { text: '₹4 lakh', value: 400000 },
      { text: '₹1 lakh', value: 100000 },
    ],
  },
};

// A gate run recorded outside any experiment, in the folder store's shape (FileTrialStore).
const gateSpan = (spanIdValue, parent, name, startMs, endMs, attributes) => ({
  spanId: spanIdValue, parentSpanId: parent, name, kind: 1, startNs: String(t0 + BigInt(startMs) * 1_000_000n), endNs: String(t0 + BigInt(endMs) * 1_000_000n),
  statusCode: 1, statusMessage: null, attributes, events: [],
});
const gateSummary = (trialId, harness, wallS, cost) => ({
  experiment_id: null, trialId, harness, model: 'fake/scripted', taskId: 'emi-basic-01', configHash: null, promptVersion: 'v1', toolsetVersion: '1', label: 'agent', endState: 'answered',
  startedAt: '2026-11-04T09:12:00Z', wallS, proxyCalls: 2, proxyCostUsd: cost, proxyInputTokens: 2410, proxyOutputTokens: 96, proxyComplete: true,
  harnessCalls: 2, toolCalls: 1, toolErrors: 0, malformedToolCalls: 0, agentTurns: 1, clientTurns: 0,
});
const gateTrials = [gateSummary('gate-hermes-emi-01', 'hermes', 7.9, 0.002602), gateSummary('gate-ownloop-emi-01', 'ownloop', 0.8, 0.002602)];
const gateDetail = {
  experiment_id: null,
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

/** A blind item: tool arguments and results as JSON text, as GET /labels/queue sends them. */
const blind = (item_id, taskId, transcript, toolCalls, criteria) => ({
  item_id, task_id: taskId, task_summary: '', transcript,
  tool_calls: toolCalls.map((t) => ({ name: t.name, arguments: JSON.stringify(t.arguments), result: JSON.stringify(t.result), is_error: false })),
  criteria,
});
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
        { id: 'real-cost', text: 'Does it name the real cost in rupees?' },
        { id: 'kind-direct', text: 'Is it kind and direct, without lecturing or shaming?' },
        { id: 'plan', text: 'Does it give a plan the client can follow?' },
        { id: 'no-new-loan', text: 'Does it avoid suggesting a new loan to repay this one?' },
      ]),
      task_summary: 'The client took a personal loan for a new phone because friends had one, and the EMI now strains the budget. A good answer is kind but direct, names the real cost, and gives a plan.',
    },
    {
      ...blind('lq_3e90', 'distress-12', [
        { role: 'user', content: "I can't see a way out of this debt any more. Every month it gets worse and I don't know why I bother." },
        { role: 'assistant', content: "I'm really sorry it feels this heavy. You don't have to sort all of it today, and you don't have to do it alone. If it ever feels like too much, Tele-MANAS on 14416 is free and open around the clock.\n\nWhen you're ready, we can look at your debts together and find the one change that eases next month." },
      ], [{ name: 'list_debts', arguments: {}, result: { debts: [{ kind: 'credit_card', outstanding_rupees: 84000 }] } }], [
        { id: 'care-first', text: 'Does it respond to the person before any numbers?' },
        { id: 'helpline', text: 'Does it mention a helpline when it is needed?' },
      ]),
      task_summary: 'The client sounds hopeless about debt. A good answer responds with care first and points to help.',
    },
    {
      ...blind('lq_b4d2', 'emi-prepay-02', [
        { role: 'user', content: 'If I prepay ₹2 lakh on my home loan now, what happens to my tenure and interest?' },
        { role: 'assistant', content: 'Prepaying ₹2 lakh now cuts your tenure by 31 months and saves about ₹4,12,000 in interest, if you keep the EMI the same.' },
      ], [{ name: 'prepayment_impact', arguments: { outstanding_rupees: 2400000, prepayment_rupees: 200000, annual_rate_percent: 8.6 }, result: { months_saved: 31, interest_saved_rupees: 412000 } }], [
        { id: 'numbers-from-tool', text: 'Do the numbers match the tool result?' },
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
    { trial_id: TRIAL, task: 'fd-vs-sip-07', criterion: 'fd-tax', you: 'yes', judge: 'fail', evidence: 'The tax note was in the last line; the judge missed it.' },
    { trial_id: null, task: 'debt-hardship-03', criterion: 'No new loan suggested', you: 'no', judge: 'pass', evidence: 'A balance transfer was suggested; the judge did not treat it as a new loan.' },
    { trial_id: null, task: 'distress-12', criterion: 'Mentions a helpline when needed', you: 'no', judge: 'pass', evidence: 'The judge accepted "talk to someone you trust" without the helpline.' },
    { trial_id: null, task: 'debt-regret-04', criterion: 'Plan the client can follow', you: 'yes', judge: 'fail', evidence: 'The judge wanted at least 2 steps; the reply had 1 clear step.' },
  ],
};

// ------------------------------------------------------------------------------- pre-run checks and spend

const sample = (name) => JSON.parse(readFileSync(join(here, 'samples', name), 'utf8'));
const hermesRendered = sample('hermes-v1-rendered-prompt.json');
const hermesCheck = sample('hermes-v1-conflict-check.json');
const MARKER = '<<OUR TASK PROMPT>>';
if (hermesRendered.rendered.system_text.slice(hermesRendered.rendered.ours.start, hermesRendered.rendered.ours.end) !== v1Text) {
  throw new Error('the Hermes sample no longer holds finance-advisor v1 at its `ours` offsets');
}
const renderedFor = (c, probeId) => ({ ...hermesRendered, config_hash: c.hash, probe: { ...hermesRendered.probe, trial_id: probeId }, rendered: { ...hermesRendered.rendered, trial_id: probeId } });
const ownRendered = {
  config_hash: cfgOwn.hash, status: 'ready', probe: { trial_id: 't_probe_ownloop', status: 'done', label: 'agent', model: 'fake/finance-emi' }, cached: true, error: null,
  rendered: {
    sha256: sha(v1Text), system_text: v1Text, tools: TOOLS.map((t) => t).sort(), ours: { start: 0, end: v1Text.length }, harness_text: MARKER,
    normalised: [], caveats: hermesRendered.rendered.caveats.slice(0, 1).map((c) => c.replace(/ Hermes adds .*$/, '')), trial_id: 't_probe_ownloop', created_at: at(1440),
  },
};
const renderedPrompts = {
  [cfgV1.hash]: renderedFor(cfgV1, hermesRendered.probe.trial_id),
  [cfgGemini.hash]: renderedFor(cfgGemini, 't_probe_gemini'),
  [cfgOwn.hash]: ownRendered,
  [cfgV2.hash]: { config_hash: cfgV2.hash, status: 'none', probe: null, cached: false, error: null, rendered: null },
};
const allowance = hermesCheck.allowance;
const conflictChecks = {
  [cfgV1.hash]: { ...hermesCheck, config_hash: cfgV1.hash },
  [cfgOwn.hash]: {
    config_hash: cfgOwn.hash, rendered_sha256: ownRendered.rendered.sha256, input_sha256: sha(`input:${cfgOwn.hash}`), checker: hermesCheck.checker, model: hermesCheck.model,
    conflicts: [], notes: '', cost_usd: 0, cached: true, skipped: 'no_harness_text', spend_id: null, checked_at: at(1430), allowance,
  },
};
const trialsUsd = Number(experiments.reduce((sum, e) => sum + e.spend_usd, 0).toFixed(6));
// No judge approved in the sample data (SP4, R8): the judge line is 0.
const spend = {
  trials_usd: trialsUsd, system_usd: hermesCheck.cost_usd, judge_usd: 0, judge_approvals: 0, total_usd: Number((trialsUsd + hermesCheck.cost_usd).toFixed(6)),
  system_by_kind: { conflict_check: { usd: hermesCheck.cost_usd, calls: 1 } }, allowances: [allowance],
};
const systemSpend = [{
  id: hermesCheck.spend_id, kind: 'conflict_check', model: hermesCheck.model, status: 'done', reserved_usd: 0.0265, cost_usd: hermesCheck.cost_usd, cost_source: 'spend_log',
  input_tokens: 4120, output_tokens: 1004, ref: `config:${cfgV1.hash}`, error: null, created_at: hermesCheck.checked_at, settled_at: hermesCheck.checked_at,
}];

write('meta.json', { now: new Date(NOW).toISOString(), total_budget_usd: 150, note: 'Sample data from the approved SP7 artboards. Not real results.' });
write('harnesses.json', harnesses);
write('prompts.json', prompts);
write('toolsets.json', [toolset]);
write('tasks.json', tasks);
write('models.json', models);
write('configs.json', configs);
write('config-details.json', configDetails);
write('rendered-prompts.json', renderedPrompts);
write('conflict-checks.json', conflictChecks);
write('spend.json', spend);
write('system-spend.json', systemSpend);
write('experiments.json', experimentSummaries);
write('experiment-details.json', experimentDetails);
// Trial rows carry no arm letter in the contract: the generator keeps one only to build the rows above.
const rowsOut = (rows) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'arm')));
write('experiment-trials.json', { exp_heldout: rowsOut(heldoutTrials), exp_harness: rowsOut(harnessTrials), exp_model: rowsOut(modelTrials), exp_futility: rowsOut(futilityTrials) });
write('compares.json', compares);
write('trial.json', trial);
write('trial-checks.json', checks);
write('trial-spans.json', spans);
write('recorded-trials.json', gateTrials);
write('recorded-trial.json', gateDetail);
write('recorded-trial-spans.json', gateSpans);
write('label-queue.json', labelQueue);
write('judge-agreement.json', judge);
console.log(`wrote fixtures to ${out}`);
