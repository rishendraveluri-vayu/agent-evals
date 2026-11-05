import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import * as files from '../src/catalogue/catalogue-files';
import type { CreatedPrompt, PromptView } from '../src/contract';
import { type TestEnv, bootEnv } from './support/app';
import { describeWithDb } from './support/db';

/** The highest N among client-sim.vN.md file names. */
function highestSim(names: string[]): number {
  return Math.max(...names.map((n) => /^client-sim\.v(\d+)\.md$/.exec(n)?.[1]).filter((v): v is string => v !== undefined).map(Number));
}

describeWithDb('POST /prompts (e2e, real Postgres, a copy of configs/)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await bootEnv();
    // These tests start from a finance-advisor with v1 only; the repo's own later versions (v2, D67)
    // are taken out of this test's copy of configs/ so the next version created here is v2.
    for (const f of await fs.readdir(path.join(env.configsDir, 'prompts'))) {
      if (/^finance-advisor\.v(?!1\.md$)\d+\.md$/.test(f)) await fs.rm(path.join(env.configsDir, 'prompts', f));
    }
  });

  afterAll(async () => {
    await env.close();
  });

  const prompts = async (): Promise<PromptView[]> => (await request(env.http).get('/api/prompts').expect(200)).body as PromptView[];
  const post = (body: unknown) => request(env.http).post('/api/prompts').send(body as object);
  const promptsDir = () => path.join(env.configsDir, 'prompts');
  const today = () => {
    const d = new Date();
    return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };

  it('creates v2 from v1 as a new file with a review header, and lists it', async () => {
    const text = 'You are a careful finance advisor (UI edit, test fixture).\n\nCheck every number with a tool.';
    const res = await post({ id: 'finance-advisor', base_version: 'v1', text }).expect(201);
    const created = res.body as CreatedPrompt;
    expect(created).toEqual({ id: 'finance-advisor', version: 'v2', sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as string, path: 'configs/prompts/finance-advisor.v2.md' });
    const file = await fs.readFile(path.join(promptsDir(), 'finance-advisor.v2.md'), 'utf8');
    expect(file).toBe(
      `<!--\nfinance-advisor v2, created from v1 in the UI on ${today()}.\n` +
        'This header comment is stripped before use. Once a run has used this version, changes go in\na new version file.\n-->\n\n' +
        `${text}\n`,
    );
    const listed = (await prompts()).find((p) => p.id === 'finance-advisor' && p.version === 'v2');
    expect(listed).toMatchObject({ sha256: created.sha256, path: created.path, text: `${text}\n` });
    // The stored row exists, so a config can point at the new version straight away.
    const [row] = (await env.pool.query('SELECT id, version FROM prompts WHERE sha256 = $1', [created.sha256])).rows as { id: string; version: string }[];
    expect(row).toEqual({ id: 'finance-advisor', version: 'v2' });
  });

  it('returns the existing version for the same text again (200), and writes no file', async () => {
    const before = await fs.readdir(promptsDir());
    const text = 'You are a careful finance advisor (UI edit, test fixture).\n\nCheck every number with a tool.';
    const again = await post({ id: 'finance-advisor', base_version: 'v2', text: `\n${text}\n\n` }).expect(200);
    expect(again.body).toMatchObject({ id: 'finance-advisor', version: 'v2', path: 'configs/prompts/finance-advisor.v2.md' });
    // The text of v1 itself is v1.
    const v1 = (await prompts()).find((p) => p.id === 'finance-advisor' && p.version === 'v1')!;
    expect((await post({ id: 'finance-advisor', base_version: 'v1', text: v1.text }).expect(200)).body).toEqual({ id: 'finance-advisor', version: 'v1', sha256: v1.sha256, path: v1.path });
    expect(await fs.readdir(promptsDir())).toEqual(before);
  });

  it('numbers past the highest version, leaving every existing file as it was', async () => {
    const before = new Map<string, string>();
    for (const name of await fs.readdir(promptsDir())) before.set(name, await fs.readFile(path.join(promptsDir(), name), 'utf8'));
    const res = await post({ id: 'client-sim', base_version: 'v1', text: 'A different simulator prompt (test fixture).' }).expect(201);
    // One past the highest client-sim file in configs/prompts, whatever that is today (v4 since 4 Nov).
    expect((res.body as CreatedPrompt).version).toBe(`v${highestSim([...before.keys()]) + 1}`);
    for (const [name, text] of before) expect(await fs.readFile(path.join(promptsDir(), name), 'utf8')).toBe(text);
  });

  it('never overwrites a file that appears at the next version: 409, and the file is kept', async () => {
    // A file the listing has not seen yet (as when another writer gets there first).
    const next = `v${highestSim(await fs.readdir(promptsDir())) + 1}`;
    const squatter = path.join(promptsDir(), `client-sim.${next}.md`);
    await fs.writeFile(squatter, `a ${next} written by hand`);
    const real = files.readPrompts;
    const spy = jest.spyOn(files, 'readPrompts').mockImplementation(async (dir) => (await real(dir)).filter((p) => !(p.id === 'client-sim' && p.version === next)));
    try {
      const res = await post({ id: 'client-sim', base_version: 'v1', text: 'Yet another simulator prompt (test fixture).' }).expect(409);
      expect(res.body).toMatchObject({ error: 'prompt_version_exists', fix: expect.any(String) as string });
      expect(await fs.readFile(squatter, 'utf8')).toBe(`a ${next} written by hand`);
    } finally {
      spy.mockRestore();
      await fs.unlink(squatter);
    }
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an unknown id', { id: 'no-such-prompt', base_version: 'v1', text: 'x' }, 'unknown_prompt_id'],
    ['an unknown base version', { id: 'finance-advisor', base_version: 'v9', text: 'x' }, 'unknown_base_version'],
    ['a path in the id', { id: '../finance-advisor', base_version: 'v1', text: 'x' }, 'invalid_prompt'],
    ['a path in the base version', { id: 'finance-advisor', base_version: '../../x', text: 'x' }, 'invalid_prompt'],
    ['an absolute path as the id', { id: '/etc/passwd', base_version: 'v1', text: 'x' }, 'invalid_prompt'],
    ['an empty text', { id: 'finance-advisor', base_version: 'v1', text: '  \n' }, 'invalid_prompt'],
    ['a text over 50 KB', { id: 'finance-advisor', base_version: 'v1', text: 'é'.repeat(25 * 1024 + 1) }, 'prompt_too_large'],
  ])('refuses %s with 400 and a fix, writing nothing', async (_what, body, code) => {
    const before = await fs.readdir(promptsDir());
    const res = await post(body).expect(400);
    expect(res.body).toMatchObject({ error: code, fix: expect.any(String) as string });
    expect(await fs.readdir(promptsDir())).toEqual(before);
  });

  it('takes a text of exactly 50 KB', async () => {
    const res = await post({ id: 'conflict-check', base_version: 'v1', text: 'a'.repeat(50 * 1024) }).expect(201);
    await fs.unlink(path.join(promptsDir(), `conflict-check.${(res.body as CreatedPrompt).version}.md`));
  });

  it('refuses a text that is already another prompt id (the prompts table is keyed by text hash)', async () => {
    const sim = (await prompts()).find((p) => p.id === 'client-sim' && p.version === 'v1')!;
    const res = await post({ id: 'finance-advisor', base_version: 'v1', text: sim.text }).expect(409);
    expect(res.body).toMatchObject({ error: 'prompt_text_exists', fix: 'Use client-sim v1, or change the text.' });
  });
});
