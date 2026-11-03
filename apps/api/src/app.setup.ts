import type { INestApplication } from '@nestjs/common';

/** App-wide settings shared by `main.ts` and the e2e tests, so tests boot the same app. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api');
  // Run onApplicationShutdown hooks (which close the database pool) on SIGTERM and SIGINT.
  app.enableShutdownHooks();
  return app;
}
