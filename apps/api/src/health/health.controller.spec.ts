import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DbState, HealthService } from './health.service';

function controllerReporting(db: DbState): HealthController {
  const service = { check: () => Promise.resolve({ status: 'ok' as const, db }) };
  return new HealthController(service as unknown as HealthService);
}

describe('HealthController', () => {
  it.each<DbState>(['up', 'not_configured'])('returns the report when db is %s', async (db) => {
    await expect(controllerReporting(db).get()).resolves.toEqual({ status: 'ok', db });
  });

  it('throws 503 with the same body when db is down', async () => {
    const error = await controllerReporting('down')
      .get()
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const unavailable = error as ServiceUnavailableException;
    expect(unavailable.getStatus()).toBe(503);
    expect(unavailable.getResponse()).toEqual({ status: 'ok', db: 'down' });
  });
});
