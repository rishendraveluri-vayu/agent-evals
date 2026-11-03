import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

const EXAMPLES = path.resolve(__dirname, '../../../contract/v2/examples');

/** A runs directory with one trial folder built from the contract's example files. */
async function makeRunsDir(): Promise<string> {
  const runs = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-runs-'));
  const trial = path.join(runs, '20261103T000000Z', 'scripted', 'test_answer', 'trial');
  await fs.mkdir(path.join(trial, 'out', 'artifacts', 'proxy'), { recursive: true });
  await fs.copyFile(path.join(EXAMPLES, 'spec.json'), path.join(trial, 'spec.json'));
  for (const name of ['result.json', 'runner-report.json', 'trace.jsonl']) {
    await fs.copyFile(path.join(EXAMPLES, name), path.join(trial, 'out', name));
  }
  await fs.writeFile(path.join(trial, 'out', 'artifacts', 'proxy', '0001.request.json'), '{"model":"fake/finance-emi"}');
  await fs.writeFile(path.join(runs, 'secret.txt'), 'outside the trial');
  return runs;
}

describe('trials API (e2e)', () => {
  let app: INestApplication<App>;
  let runs: string;
  const original = process.env.RUNS_DIR;

  beforeAll(async () => {
    runs = await makeRunsDir();
    process.env.RUNS_DIR = runs;
    delete process.env.DATABASE_URL;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(runs, { recursive: true, force: true });
    if (original === undefined) delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = original;
  });

  it('lists trials with the numbers the spend chart needs', async () => {
    const res = await request(app.getHttpServer()).get('/api/trials').expect(200);
    expect(res.body).toHaveLength(1);
    const [row] = res.body as Record<string, unknown>[];
    expect(row).toMatchObject({
      trialId: 't_01JEXAMPLE0001',
      harness: 'scripted',
      label: 'agent',
      endState: 'answered',
      harnessCalls: 2,
      toolCalls: 1,
      promptVersion: 'v1',
    });
  });

  it('returns one trial with its spec, result and report', async () => {
    const res = await request(app.getHttpServer()).get('/api/trials/t_01JEXAMPLE0001').expect(200);
    const body = res.body as { result: { end_state: string }; spec: { contract_version: string } };
    expect(body.result.end_state).toBe('answered');
    expect(body.spec.contract_version).toBe('2');
  });

  it('returns spans with plain attributes, oldest first', async () => {
    const res = await request(app.getHttpServer()).get('/api/trials/t_01JEXAMPLE0001/spans').expect(200);
    const spans = res.body as { name: string; parentSpanId: string | null; attributes: Record<string, unknown>; startNs: string }[];
    const root = spans.find((s) => s.parentSpanId === null);
    expect(root?.name).toBe('invoke_agent scripted');
    expect(root?.attributes['evals.end_state']).toBe('answered');
    const chat = spans.find((s) => s.name.startsWith('chat '));
    expect(chat?.attributes['gen_ai.usage.output_tokens']).toBe(13);
    const starts = spans.map((s) => BigInt(s.startNs));
    expect([...starts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(starts);
  });

  it('serves a stored file and refuses paths outside the trial', async () => {
    const ok = await request(app.getHttpServer())
      .get('/api/trials/t_01JEXAMPLE0001/files/artifacts/proxy/0001.request.json')
      .expect(200);
    expect(ok.text).toContain('fake/finance-emi');
    await request(app.getHttpServer()).get('/api/trials/t_01JEXAMPLE0001/files/..%2F..%2F..%2Fsecret.txt').expect(404);
    await request(app.getHttpServer()).get('/api/trials/t_01JEXAMPLE0001/files/../../secret.txt').expect(404);
  });

  it('answers 404 for an unknown trial', async () => {
    await request(app.getHttpServer()).get('/api/trials/nope').expect(404);
    await request(app.getHttpServer()).get('/api/trials/nope/spans').expect(404);
  });
});
