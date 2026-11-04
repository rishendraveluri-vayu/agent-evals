import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { Db } from './db.service';
import { PG_POOL, createPool } from './pg-pool';

/**
 * Owns the Postgres connection pool: creates it from DATABASE_URL at startup
 * and closes it when the application shuts down. `Db` runs the migrations.
 */
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool | null => createPool(process.env.DATABASE_URL),
    },
    Db,
  ],
  exports: [PG_POOL, Db],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }
}
