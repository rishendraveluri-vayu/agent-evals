import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { ExperimentDetail } from '../src/contract';
import { type TestEnv, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';

/**
 * G2: the platform commit an experiment records. With EVALS_PLATFORM_COMMIT set it is recorded
 * as given (`env`); left blank, as on a plain `docker compose up`, the API reads the checkout's
 * HEAD from its .git each time an experiment is created (`git`). The .git here is synthetic.
 */

const A = 'a1'.repeat(20);
const B = 'b2'.repeat(20);

async function create(env: TestEnv, configs: string[], task: string, extra: Record<string, unknown> = {}): Promise<ExperimentDetail> {
  const res = await request(env.http)
    .post('/api/experiments')
    .send({ name: 'commit check', axis: 'temperature', config_hashes: configs, task_sha256s: [task], n: 1, sim_model: null, budget_usd: 5, ...extra })
    .expect(201);
  return res.body as ExperimentDetail;
}

describeWithDb('the platform commit an experiment records (G2, e2e, real Postgres)', () => {
  describe('with EVALS_PLATFORM_COMMIT set', () => {
    let env: TestEnv;

    beforeAll(async () => {
      env = await bootEnv({ platformCommit: 'abc1234' });
    });

    afterAll(async () => {
      await env.close();
    });

    it('records the variable as given, marked env', async () => {
      const cat = await catalogue(env.http);
      const exp = await create(env, [await makeConfig(env.http, cat)], cat.tasks['emi-basic']);
      expect(exp).toMatchObject({ platform_commit: 'abc1234', platform_commit_source: 'env' });
      const [row] = (await env.pool.query<{ platform_commit: string; platform_commit_source: string }>('SELECT platform_commit, platform_commit_source FROM experiments WHERE id = $1', [exp.id])).rows;
      expect(row).toEqual({ platform_commit: 'abc1234', platform_commit_source: 'env' });
    });
  });

  describe('with it blank, as on a plain docker compose up', () => {
    let env: TestEnv;
    let tmp: string;
    let dotGit: string;

    beforeAll(async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-checkout-'));
      dotGit = path.join(tmp, '.git');
      await fs.mkdir(path.join(dotGit, 'refs', 'heads'), { recursive: true });
      await fs.writeFile(path.join(dotGit, 'HEAD'), 'ref: refs/heads/main\n');
      await fs.writeFile(path.join(dotGit, 'refs', 'heads', 'main'), `${A}\n`);
      env = await bootEnv({ platformCommit: '', gitDir: dotGit });
    });

    afterAll(async () => {
      await env.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it("reads the checkout's HEAD when each experiment is created, and the baseline decision compares that", async () => {
      const cat = await catalogue(env.http);
      const a = await makeConfig(env.http, cat, { name: 'arm A', settings: { temperature: 0.2 } });
      const b = await makeConfig(env.http, cat, { name: 'arm B', settings: { temperature: 0.7 } });
      const parent = await create(env, [a, b], cat.tasks['emi-basic']);
      expect(parent).toMatchObject({ platform_commit: A, platform_commit_source: 'git' });

      // A new commit on the branch while the API runs: the next experiment records it.
      await fs.writeFile(path.join(dotGit, 'refs', 'heads', 'main'), `${B}\n`);
      const child = await create(env, [a, b], cat.tasks['emi-basic']);
      expect(child).toMatchObject({ platform_commit: B, platform_commit_source: 'git' });

      // D34 reuses arm A only under the same, known platform commit: the one just read.
      const est = await request(env.http)
        .post('/api/experiments/estimate')
        .send({ config_hashes: [a, b], task_sha256s: [cat.tasks['emi-basic']], n: 1, sim_model: null, parent_experiment_id: parent.id, reuse_baseline: true })
        .expect(200);
      expect((est.body as { baseline: { reason: string } }).baseline.reason).toContain(`the platform commit differs (parent ${A}, now ${B})`);
    });

    it('records no commit, never a guess, when the checkout has none to read', async () => {
      await fs.rm(path.join(dotGit, 'HEAD'));
      const cat = await catalogue(env.http);
      const exp = await create(env, [await makeConfig(env.http, cat, { name: 'no head' })], cat.tasks['emi-basic']);
      expect(exp).toMatchObject({ platform_commit: null, platform_commit_source: null });
    });
  });
});
