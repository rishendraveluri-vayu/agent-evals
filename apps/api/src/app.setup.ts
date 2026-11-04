import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** A worker's report carries every span of a trial inline; 100 kB (Express's default) is too small. */
export const JSON_BODY_LIMIT = '50mb';

/** App-wide settings shared by `main.ts` and the e2e tests, so tests boot the same app. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api');
  (app as NestExpressApplication).useBodyParser('json', { limit: JSON_BODY_LIMIT });
  // Run onApplicationShutdown hooks (which close the database pool) on SIGTERM and SIGINT.
  app.enableShutdownHooks();
  return app;
}
