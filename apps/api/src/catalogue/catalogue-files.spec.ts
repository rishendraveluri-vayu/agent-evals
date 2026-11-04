import { promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashCanonical } from '../common/hashing';
import type { Json } from '../contract';
import {
  FINANCE_TOOLS,
  type FinanceServerManifest,
  PROMPT_NAME_PART,
  type PublishedTool,
  builtInToolsets,
  checkTask,
  headerDate,
  loadFinanceServer,
  nextPromptVersion,
  parsePromptName,
  parsePyproject,
  promptFile,
  promptText,
  readHarnesses,
  readPrompts,
  readTasks,
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
  });
});

describe('the built-in toolset', () => {
  it('has exactly the finance server tools from its manifest snapshot', () => {
    const snapshot = JSON.parse(readFileSync(path.join(REPO, 'services/finance-mcp/tests/snapshots/tools_manifest.json'), 'utf8')) as { name: string }[];
    expect([...FINANCE_TOOLS]).toEqual(snapshot.map((t) => t.name));
  });

  const server = loadFinanceServer(path.join(REPO, 'services/finance-mcp'));

  it('is finance/all with a content hash over the published manifest', () => {
    const [t] = builtInToolsets(server);
    expect(t).toMatchObject({ id: 'finance', version: 'all', servers: [{ name: 'finance' }] });
    expect(t.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(t.manifest).toHaveLength(1);
    expect(t.manifest[0].server_version).toBe(server.version);
    expect(t.manifest[0].tools.map((x) => x.name)).toEqual([...FINANCE_TOOLS]);
    const sip = t.manifest[0].tools.find((x) => x.name === 'sip_future_value');
    expect(Object.keys((sip?.input_schema as { properties: object }).properties)).toContain('lump_sum');
    const { sha256, ...content } = t;
    expect(sha256).toBe(hashCanonical(content));
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
    const namesOnly = hashCanonical({ id: 'finance', version: 'all', servers: [{ name: 'finance', allowed_tools: [...FINANCE_TOOLS] }] });
    expect(base.sha256).not.toBe(namesOnly);
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

  it('accepts the minimum the engine reads', () => {
    expect(checkTask(good)).toEqual([]);
  });

  it('accepts required_tools naming finance tools (a grader primitive)', () => {
    expect(checkTask({ ...good, required_tools: ['calculate_emi', 'list_debts'] })).toEqual([]);
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
  ])('flags %s', (_what, change, word) => {
    expect(checkTask({ ...good, ...change }).join(' ')).toContain(word);
  });

  it('hashes task.json bytes, reads the client state, and keeps a bad task listed with its problems', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-tasks-'));
    try {
      await fs.mkdir(path.join(dir, 'emi-01'));
      await fs.writeFile(path.join(dir, 'emi-01', 'task.json'), JSON.stringify({ ...good, client_state: 'client.json' }));
      await fs.writeFile(path.join(dir, 'emi-01', 'client.json'), '{"name":"test"}');
      await fs.mkdir(path.join(dir, 'broken'));
      await fs.writeFile(path.join(dir, 'broken', 'task.json'), '{not json');
      const tasks = await readTasks(dir);
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
