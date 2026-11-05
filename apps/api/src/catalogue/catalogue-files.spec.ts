import { promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashCanonical } from '../common/hashing';
import type { Json } from '../contract';
import {
  ARITHMETIC_TOOLS,
  CALCULATOR_TOOLS,
  FINANCE_TOOLS,
  FINANCE_TOOLSET_VERSION,
  GRADER_SCHEMA_FILE,
  REFERENCE_TOOLS,
  type FinanceServerManifest,
  PROMPT_NAME_PART,
  type PublishedTool,
  builtInToolsets,
  checkTask,
  headerDate,
  isScaffolded,
  loadFinanceServer,
  loadGraderCheck,
  nextPromptVersion,
  parsePromptName,
  parsePyproject,
  promptFile,
  promptText,
  readHarnesses,
  readPrompts,
  readTasks,
  toolsetContent,
} from './catalogue-files';

const REPO = path.resolve(__dirname, '../../../..');

describe('prompt files', () => {
  it('strips the leading review header, as gate.prompt_text does', () => {
    expect(promptText('<!--\nDRAFT v1\n-->\n\nYou are an advisor.\n\n')).toBe('You are an advisor.\n');
    expect(promptText('No header.')).toBe('No header.\n');
  });

  it('reads id and version from the file name', () => {
    expect(parsePromptName('finance-advisor.v1.md')).toEqual({ id: 'finance-advisor', version: 'v1' });
    expect(parsePromptName('client-sim.v10.md')).toEqual({ id: 'client-sim', version: 'v10' });
    expect(parsePromptName('README.md')).toBeNull();
  });

  it('lists the repo prompts with the sha256 of their text', async () => {
    const prompts = await readPrompts(path.join(REPO, 'configs'));
    const advisor = prompts.find((p) => p.id === 'finance-advisor');
    expect(advisor?.version).toBe('v1');
    expect(advisor?.text.startsWith('<!--')).toBe(false);
    expect(advisor?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('new prompt versions (POST /prompts)', () => {
  it('numbers the next version after the highest v<n>, in numeric order', () => {
    expect(nextPromptVersion(['v1'])).toBe('v2');
    expect(nextPromptVersion(['v1', 'v3', 'v2'])).toBe('v4');
    expect(nextPromptVersion(['v9', 'v10'])).toBe('v11');
    expect(nextPromptVersion(['draft', 'v2'])).toBe('v3');
    expect(nextPromptVersion([])).toBe('v1');
  });

  it('writes a review header in the existing style, which promptText strips again', () => {
    const file = promptFile('finance-advisor', 'v2', 'v1', '\nBe kind.\n\n', new Date('2026-11-04T23:30:00Z'));
    expect(file).toBe(
      '<!--\nfinance-advisor v2, created from v1 in the UI on 4 Nov 2026.\n' +
        'This header comment is stripped before use. Once a run has used this version, changes go in\na new version file.\n-->\n\nBe kind.\n',
    );
    expect(promptText(file)).toBe('Be kind.\n');
    // A text with its own comment keeps it: only the first header is stripped.
    expect(promptText(promptFile('p', 'v2', 'v1', '<!-- mine -->\nText', new Date()))).toBe('<!-- mine -->\nText\n');
    expect(headerDate(new Date('2026-01-09T00:00:00Z'))).toBe('9 Jan 2026');
  });

  it('allows no separators in ids and versions, so a file name cannot leave configs/prompts', () => {
    for (const ok of ['finance-advisor', 'client-sim', 'v12']) expect(PROMPT_NAME_PART.test(ok)).toBe(true);
    for (const bad of ['../finance-advisor', 'a/b', 'a\\b', '.hidden', 'v1.md', '', 'x\0']) expect(PROMPT_NAME_PART.test(bad)).toBe(false);
  });
});

describe('harness files', () => {
  it('reads version and requires-python from [project] only', () => {
    const toml = '[project]\nname = "x"\nversion = "0.1.0"\nrequires-python = ">=3.14"\n\n[tool.uv]\nversion = "9"\n';
    expect(parsePyproject(toml)).toEqual({ version: '0.1.0', python: '>=3.14' });
    expect(parsePyproject('[tool]\n')).toEqual({ version: null, python: null });
  });

  it('finds every adapter capabilities file under workers/', async () => {
    const harnesses = await readHarnesses(path.join(REPO, 'workers'));
    expect(harnesses.map((h) => h.name)).toEqual(expect.arrayContaining(['hermes', 'ownloop']));
    const hermes = harnesses.find((h) => h.name === 'hermes');
    expect(hermes).toMatchObject({ package: 'hermes-agent', ref: '6112c2adb9e11f69734a29be9d2696f345ffa06a', python: '>=3.14', dir: 'workers/hermes' });
    expect(hermes?.capabilities_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Every harness in the repo is implemented: none still has the scaffold's TODO version.
    expect(harnesses.filter((h) => h.scaffolded).map((h) => h.name)).toEqual([]);
  });

  it('marks a harness `make new-harness` made and nobody finished as scaffolded (A2)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-workers-'));
    // What scaffold.py writes into capabilities.json's version, then one with only the package filled.
    const write = async (name: string, version: { package: string; ref: string }): Promise<void> => {
      const pkg = path.join(dir, name, 'src', `${name}_adapter`);
      await fs.mkdir(pkg, { recursive: true });
      const caps = { contract_version: '2', harness: name, version, model_api_formats: ['openai_chat'], settings: {}, known_differences: [] };
      await fs.writeFile(path.join(pkg, 'capabilities.json'), JSON.stringify(caps, null, 2));
      await fs.writeFile(path.join(dir, name, 'pyproject.toml'), `[project]\nname = "${name}-worker"\nversion = "0.1.0"\nrequires-python = ">=3.14"\n`);
    };
    try {
      await write('crewai', { package: 'TODO', ref: 'TODO' });
      await write('halfway', { package: 'halfway', ref: 'TODO' });
      await write('finished', { package: 'finished', ref: '1.2.3' });
      const byName = new Map((await readHarnesses(dir)).map((h) => [h.name, h]));
      expect(byName.get('crewai')).toMatchObject({ scaffolded: true, capabilitiesPath: 'workers/crewai/src/crewai_adapter/capabilities.json', dir: 'workers/crewai' });
      expect(byName.get('halfway')?.scaffolded).toBe(true);
      expect(byName.get('finished')?.scaffolded).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('calls a version scaffolded while its package or ref is still the placeholder', () => {
    expect(isScaffolded({ package: 'TODO', ref: 'TODO' })).toBe(true);
    expect(isScaffolded({ package: 'langgraph', ref: 'TODO' })).toBe(true);
    expect(isScaffolded({ package: 'TODO', ref: '1.0.0' })).toBe(true);
    expect(isScaffolded({ package: 'langgraph', ref: '1.0.0' })).toBe(false);
  });
});

describe('the built-in toolset', () => {
  it('has exactly the finance server tools from its manifest snapshot', () => {
    const snapshot = JSON.parse(readFileSync(path.join(REPO, 'services/finance-mcp/tests/snapshots/tools_manifest.json'), 'utf8')) as { name: string }[];
    expect([...FINANCE_TOOLS]).toEqual(snapshot.map((t) => t.name));
  });

  const server = loadFinanceServer(path.join(REPO, 'services/finance-mcp'));

  it('is finance/v3 with a content hash over the published manifest', () => {
    const [t] = builtInToolsets(server);
    expect(t).toMatchObject({ id: 'finance', version: 'v3', servers: [{ name: 'finance' }] });
    expect(t.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(t.manifest).toHaveLength(1);
    expect(t.manifest[0].server_version).toBe(server.version);
    expect(t.manifest[0].tools.map((x) => x.name)).toEqual([...FINANCE_TOOLS]);
    const sip = t.manifest[0].tools.find((x) => x.name === 'sip_future_value');
    expect(Object.keys((sip?.input_schema as { properties: object }).properties)).toContain('lump_sum');
    expect(t.sha256).toBe(hashCanonical(toolsetContent(t)));
    expect(t.validation_only).toBe(false);
  });

  it('lists finance-no-calculators after it (D70): the same server and version without the eight calculators, never a default', () => {
    const [full, broken, ...rest] = builtInToolsets(server);
    expect(rest).toEqual([]);
    // First listed is what a new config and the builder take, so the validation toolset is second.
    expect(full).toMatchObject({ id: 'finance', validation_only: false });
    expect(broken).toMatchObject({ id: 'finance-no-calculators', version: FINANCE_TOOLSET_VERSION, validation_only: true, servers: [{ name: 'finance' }] });
    expect(broken.description).toMatch(/^Validation only \(D70/);
    expect(broken.description).toContain('eight calculators removed');
    expect([...CALCULATOR_TOOLS].sort()).toEqual(
      ['amortization_schedule', 'calculate_emi', 'debt_payoff_plan', 'fd_maturity', 'inflation_adjusted_value', 'loan_affordability', 'prepayment_impact', 'sip_future_value'],
    );
    const eleven = [
      'get_client_profile', 'list_debts', 'list_transactions',
      'add', 'subtract', 'multiply', 'divide', 'percent_of', 'percent_change', 'round',
      'reference_rates',
    ];
    expect(broken.servers[0].allowed_tools).toEqual(eleven);
    // Each kept tool is exactly what finance/v3 shows the model: only the list is shorter.
    expect(broken.manifest[0].server_version).toBe(full.manifest[0].server_version);
    expect(broken.manifest[0].tools).toEqual(full.manifest[0].tools.filter((x) => eleven.includes(x.name)));
    // Its hash covers its own allowed list and manifest, so it is not finance/v3's.
    expect(broken.sha256).toBe(hashCanonical(toolsetContent(broken)));
    expect(broken.sha256).not.toBe(full.sha256);
  });

  it("changes its hash when a tool's description, input schema or the server version changes", () => {
    const [base] = builtInToolsets(server);
    const edit = (change: (s: FinanceServerManifest) => void): string => {
      const copy = JSON.parse(JSON.stringify(server)) as FinanceServerManifest;
      change(copy);
      return builtInToolsets(copy)[0].sha256;
    };
    const sip = (s: FinanceServerManifest) => s.tools.find((x) => x.name === 'sip_future_value') as PublishedTool;
    const hashes = [
      edit((s) => (sip(s).description = `${sip(s).description} (edited)`)),
      // The 4 Nov change: the SIP tool without its lump_sum parameter, as it was before.
      edit((s) => delete (sip(s).input_schema as { properties: Record<string, unknown> }).properties.lump_sum),
      edit((s) => (s.version = '0.1.0-old')),
    ];
    expect(new Set([base.sha256, ...hashes]).size).toBe(4);
    // Key order inside a schema is not content: canonical JSON sorts it.
    const reversed = (o: Record<string, Json>): Json => Object.fromEntries(Object.entries(o).reverse());
    expect(edit((s) => (sip(s).input_schema = reversed(sip(s).input_schema as Record<string, Json>)))).toBe(base.sha256);
    // The names-only hash of before 4 Nov is not what it is any more.
    const namesOnly = hashCanonical({ id: 'finance', version: FINANCE_TOOLSET_VERSION, servers: [{ name: 'finance', allowed_tools: [...FINANCE_TOOLS] }] });
    expect(base.sha256).not.toBe(namesOnly);
  });

  it('gives every harness the seven arithmetic tools after the eleven finance tools (D54), then reference_rates (D58)', () => {
    const [t] = builtInToolsets(server);
    const allowed = t.servers[0].allowed_tools;
    expect(allowed).toHaveLength(19);
    expect(allowed.slice(11, 18)).toEqual([...ARITHMETIC_TOOLS]);
    expect(allowed.slice(18)).toEqual([...REFERENCE_TOOLS]);
    expect(t.manifest[0].server_version).toBe('0.4.1');
    const rates = t.manifest[0].tools.find((x) => x.name === 'reference_rates');
    expect(rates?.description).toMatch(/^Documented Indian market assumptions/);
    expect(rates?.description).toMatch(/dated snapshot, not live rates\.$/);
    expect(rates?.input_schema).toEqual({ properties: {}, required: [], type: 'object', additionalProperties: false });
    const add = t.manifest[0].tools.find((x) => x.name === 'add');
    expect(add?.description).toMatch(/^The sum of two or more numbers/);
    expect(add?.input_schema).toMatchObject({ properties: { values: { type: 'array', minItems: 2 } }, required: ['values'] });
  });

  // A change to the finance tools is a new toolset version, never an edit of an old one in place:
  // recorded configs and trials keep the hash they were made with. If this fails after a
  // deliberate tool change, add the next version to FINANCE_TOOLSET_VERSION (with a line saying
  // what changed) and pin its hash here; do not re-pin this one.
  it('pins the hash of each toolset version it lists', () => {
    // finance/all is not pinned: it kept its label while its hash changed (names only before
    // 4 Nov, sha256:e8a33031..., then the manifest at server 0.2.0, sha256:76def651...), which is
    // what this test now prevents. v2 (server 0.3.0) is no longer listed, and is kept here as the
    // record of the hash its configs and trials carry.
    const pinned: Record<string, string> = {
      'finance/v2': 'sha256:58700d434a81fa022fa63ddccda368d805775d5a6b1e9b7c55af7d09789ccb82',
      // Re-pinned once, on 5 Nov, before any run used v3: server 0.4.0 (seven proposed rates,
      // sha256:ffb60630...) became 0.4.1 (six approved, debt_fund removed).
      'finance/v3': 'sha256:8e0508d29b7d8b66b32454c2e884092bbe3b41d45bf27667bd91715eeb987148',
      // D70's positive control (5 Nov): finance/v3 without the eight calculators.
      'finance-no-calculators/v3': 'sha256:34e53515c2a9306abf04b3bc76c768ea4cd62338eaad47622589ef195a7232fd',
    };
    const listed = builtInToolsets(server);
    expect(listed.map((t) => t.version)).toEqual([FINANCE_TOOLSET_VERSION, FINANCE_TOOLSET_VERSION]);
    for (const t of listed) expect([`${t.id}/${t.version}`, t.sha256]).toEqual([`${t.id}/${t.version}`, pinned[`${t.id}/${t.version}`]]);
  });

  it('refuses a manifest that is missing a tool, or a server folder it cannot read', async () => {
    expect(() => builtInToolsets({ ...server, tools: server.tools.slice(1) })).toThrow('calculate_emi');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-finance-'));
    try {
      expect(() => loadFinanceServer(dir)).toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('task files', () => {
  const good = { id: 'emi-01', version: '1', split: 'discovery', messages: [{ role: 'user', content: 'hi' }], client_sim: null, graders: [] };
  /** The grader framework's own schema, read from the repo as the API reads it. */
  const SCHEMA = path.join(REPO, GRADER_SCHEMA_FILE);
  const graders = loadGraderCheck(SCHEMA);
  const check = (task: unknown): string[] => checkTask(task, graders);

  it('accepts the minimum the engine reads', () => {
    expect(check(good)).toEqual([]);
  });

  it('accepts a grader severity of critical, major or minor (D10), or none', () => {
    const graders = ['critical', 'major', 'minor'].map((severity, i) => ({ id: `g${i}`, type: 'end_state', states: ['answered'], severity }));
    expect(check({ ...good, graders: [...graders, { id: 'plain', type: 'end_state', states: ['answered'] }] })).toEqual([]);
  });

  it('accepts required_tools naming finance tools (a grader primitive)', () => {
    expect(check({ ...good, required_tools: ['calculate_emi', 'list_debts'] })).toEqual([]);
  });

  it('accepts every grader type in the shape the grader schema allows', () => {
    const all = [
      { id: 'emi', type: 'number', expected: { from_tool: 'calculate_emi', field: 'emi', call: 'last' }, tolerance: { abs: 1 }, target: 'final_answer', match: 'amount' },
      { id: 'used', type: 'tool_called', tool: 'mcp__finance__calculate_emi', args: { principal: 1000000 }, min_calls: 1, successful: true },
      { id: 'no-sip', type: 'tool_not_called', tool: 'sip_future_value' },
      { id: 'says', type: 'regex_present', pattern: '8,997', case_sensitive: false },
      { id: 'no-promise', type: 'regex_absent', pattern: 'guaranteed', target: 'all_agent_text' },
      { id: 'answered', type: 'end_state', states: ['answered'], required: false, description: 'ended with an answer' },
      { id: 'every-amount', type: 'provenance', max_unsupported: 0 },
      { id: 'tools', type: 'required_tools', successful: true },
      { id: 'unit', type: 'unit_test', file: 'grader.py', function: 'grade', timeout_s: 5 },
      { id: 'tone', type: 'judge', rubric: { id: 'advice', version: 'v1' }, criteria: ['acknowledges', { id: 'clear', text: 'Clear', required: false }] },
    ];
    expect(check({ ...good, graders: all })).toEqual([]);
  });

  // A5: each was an `error` grade after a paid trial; now each is a task problem before any trial.
  it.each<[string, unknown, string]>([
    ['a misspelt field', { id: 'emi', type: 'number', expected: 1, tolerence: { abs: 1 } }, 'graders[0].tolerence is not a field this grader type takes'],
    ['an unknown grader type', { id: 'emi', type: 'numbr', expected: 1 }, 'graders[0].type must be one of number, tool_called'],
    ['a field the type needs', { id: 'emi', type: 'number' }, 'graders[0].expected is missing'],
    ['a judge without its rubric', { id: 'tone', type: 'judge', criteria: ['clear'] }, 'graders[0].rubric is missing'],
    ['a value of the wrong kind', { id: 'used', type: 'tool_called', tool: 'calculate_emi', min_calls: 0 }, 'graders[0].min_calls must be >= 1'],
    ['an expected value in neither allowed shape', { id: 'emi', type: 'number', expected: 'emi' }, 'graders[0].expected does not fit any of the shapes the schema allows'],
    ['a nested typo', { id: 'emi', type: 'number', expected: { from_tool: 'calculate_emi', feild: 'emi' } }, 'graders[0].expected'],
    ['a list item outside its enum', { id: 'end', type: 'end_state', states: ['answerd'] }, 'graders[0].states[0] must be one of answered'],
    ['an id with capitals', { id: 'EMI', type: 'end_state', states: ['answered'] }, 'graders[0].id must match pattern'],
    ['an unknown grader severity', { id: 'emi', type: 'number', expected: 1, severity: 'blocker' }, 'graders[0].severity must be one of critical, major, minor'],
    ['a grader that is not an object', 'emi', 'graders[0] must be a JSON object'],
  ])('flags %s in a grader, naming where', (_what, grader, words) => {
    expect(check({ ...good, graders: [grader] }).join(' | ')).toContain(words);
  });

  it('says each grader problem once, without the schema plumbing (if/then, oneOf branches)', () => {
    const problems = check({ ...good, graders: [{ id: 'emi', type: 'number', expected: 'emi', tolerence: 1 }] });
    expect(problems).toEqual(['graders[0].tolerence is not a field this grader type takes', 'graders[0].expected does not fit any of the shapes the schema allows']);
  });

  it('flags two graders with one id, as the grader framework does', () => {
    const twice = { ...good, graders: [{ id: 'a', type: 'provenance' }, { id: 'b', type: 'provenance' }, { id: 'a', type: 'required_tools' }] };
    expect(check(twice)).toEqual(['graders[2].id "a" is used by more than one grader in this task']);
  });

  it('never passes graders it could not check: a missing schema is a problem on every grader', () => {
    const blind = loadGraderCheck(path.join(os.tmpdir(), 'no-such-dir', 'grader-spec.schema.json'));
    const problems = checkTask({ ...good, graders: [{ id: 'answered', type: 'end_state', states: ['answered'] }] }, blind);
    expect(problems).toEqual([expect.stringContaining('graders[0] cannot be checked: the API could not load the grader schema') as string]);
    expect(checkTask(good, blind)).toEqual([]); // no graders, nothing to check
  });

  it('loads every task in tasks/ with no problems against the real grader schema', async () => {
    const tasks = await readTasks(path.join(REPO, 'tasks'), SCHEMA);
    expect(tasks.length).toBeGreaterThan(10);
    expect(tasks.filter((t) => t.graders.length).length).toBeGreaterThan(10);
    expect(tasks.filter((t) => t.problems.length).map((t) => [t.sourcePath, t.problems])).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['bad split', { split: 'heldout' }, 'split'],
    ['no messages', { messages: [] }, 'messages'],
    ['assistant last', { messages: [{ role: 'assistant', content: 'x' }] }, "user's"],
    ['simulator with a model', { client_sim: { persona: 'p', hidden_facts: [], concerns: ['c'], goal: 'g', opening_message: 'o', max_client_turns: 2, model: {} } }, 'model'],
    ['simulator missing a field', { client_sim: { persona: 'p' } }, 'goal'],
    ['state file with a path', { client_state: '../secret.json' }, 'client_state'],
    ['an unknown required tool', { required_tools: ['calculate_emi', 'mcp__finance__list_debts'] }, 'required_tools'],
    ['required tools that are not a list', { required_tools: 'calculate_emi' }, 'required_tools'],
    ['a repeated required tool', { required_tools: ['calculate_emi', 'calculate_emi'] }, 'repeat'],
    ['graders that are not a list', { graders: { id: 'emi' } }, 'graders must be a list'],
  ])('flags %s', (_what, change, word) => {
    expect(check({ ...good, ...change }).join(' ')).toContain(word);
  });

  it('hashes task.json bytes, reads the client state, and keeps a bad task listed with its problems', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-tasks-'));
    try {
      await fs.mkdir(path.join(dir, 'emi-01'));
      await fs.writeFile(path.join(dir, 'emi-01', 'task.json'), JSON.stringify({ ...good, client_state: 'client.json' }));
      await fs.writeFile(path.join(dir, 'emi-01', 'client.json'), '{"name":"test"}');
      await fs.mkdir(path.join(dir, 'broken'));
      await fs.writeFile(path.join(dir, 'broken', 'task.json'), '{not json');
      const tasks = await readTasks(dir, SCHEMA);
      const emi = tasks.find((t) => t.id === 'emi-01');
      expect(emi?.problems).toEqual([]);
      expect(emi?.kind).toBe('single_prompt');
      expect(emi?.summary).toBe('hi');
      expect(emi?.clientState?.toString()).toBe('{"name":"test"}');
      expect(tasks.find((t) => t.id === 'broken')?.problems[0]).toContain('not JSON');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
