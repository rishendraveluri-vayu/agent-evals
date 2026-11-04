import { Module } from '@nestjs/common';
import * as path from 'node:path';
import { DbTrialsService } from './db-trials.service';
import { FileTrialStore, TRIAL_STORE } from './trial-store';
import { TrialsController } from './trials.controller';

/** RUNS_DIR holds trial folders: SP1 gate and smoke runs, and experiment attempts. */
export function runsDir(): string {
  return path.resolve(process.env.RUNS_DIR ?? 'runs');
}

@Module({
  controllers: [TrialsController],
  providers: [{ provide: TRIAL_STORE, useFactory: () => new FileTrialStore(runsDir()) }, DbTrialsService],
})
export class TrialsModule {}
