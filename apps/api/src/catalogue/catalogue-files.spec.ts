import { promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FINANCE_TOOLS, builtInToolsets, checkTask, parsePromptName, parsePyproject, promptText, readHarnesses, readPrompts, readTasks } from './catalogue-files';

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

  it('is finance/all with a content hash', () => {
    const [t] = builtInToolsets();
    expect(t).toMatchObject({ id: 'finance', version: 'all', servers: [{ name: 'finance' }] });
    expect(t.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
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
