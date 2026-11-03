import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/** Boots the real AppModule with the given DATABASE_URL (or none). */
async function bootApp(databaseUrl: string | undefined): Promise<INestApplication<App>> {
  if (databaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = databaseUrl;
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

describe('GET /api/health (e2e)', () => {
  const originalUrl = process.env.DATABASE_URL;
  let app: INestApplication<App> | undefined;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
  });

  it('returns 200 and not_configured when DATABASE_URL is unset', async () => {
    app = await bootApp(undefined);

    const res = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'not_configured' });
  });

  it('returns 503 and down when the database refuses connections', async () => {
    // Port 1 on loopback has no listener, so the connect fails at once.
    app = await bootApp('postgresql://evals:evals@127.0.0.1:1/evals');

    const res = await request(app.getHttpServer()).get('/api/health').expect(503);

    expect(res.body).toEqual({ status: 'ok', db: 'down' });
  });

  it('serves nothing outside the api prefix', async () => {
    app = await bootApp(undefined);

    await request(app.getHttpServer()).get('/health').expect(404);
  });
});
