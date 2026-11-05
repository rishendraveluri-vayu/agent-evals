import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DbState, HealthReport, HealthService } from './health.service';

function controllerReporting(report: HealthReport): HealthController {
  const service = { check: () => Promise.resolve(report) };
  return new HealthController(service as unknown as HealthService);
}

const ok = (db: DbState): HealthReport => ({ status: 'ok', db, files: 'writable' });

async function refusal(report: HealthReport): Promise<ServiceUnavailableException> {
  const error = await controllerReporting(report)
    .get()
    .then(
      () => undefined,
      (err: unknown) => err,
    );
  expect(error).toBeInstanceOf(ServiceUnavailableException);
  return error as ServiceUnavailableException;
}

describe('HealthController', () => {
  it.each<DbState>(['up', 'not_configured'])('returns the report when db is %s and the folders are writable', async (db) => {
    await expect(controllerReporting(ok(db)).get()).resolves.toEqual({ status: 'ok', db, files: 'writable' });
  });

  it('throws 503 with the same body when db is down', async () => {
    const unavailable = await refusal(ok('down'));
    expect(unavailable.getStatus()).toBe(503);
    expect(unavailable.getResponse()).toEqual({ status: 'ok', db: 'down', files: 'writable' });
  });

  it('throws 503 with the plain-words problem when a folder is not writable, even with the database up', async () => {
    const report: HealthReport = { status: 'ok', db: 'up', files: 'not_writable', files_problem: 'The API cannot write to runs/ ...' };
    const unavailable = await refusal(report);
    expect(unavailable.getStatus()).toBe(503);
    expect(unavailable.getResponse()).toEqual(report);
  });
});
