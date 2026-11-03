import { Module } from '@nestjs/common';
import * as path from 'node:path';
import { FileTrialStore, TRIAL_STORE } from './trial-store';
import { TrialsController } from './trials.controller';

/** RUNS_DIR is where finished trial folders are read from until SP2 stores them in the database. */
export function runsDir(): string {
  return path.resolve(process.env.RUNS_DIR ?? 'runs');
}

@Module({
  controllers: [TrialsController],
  providers: [{ provide: TRIAL_STORE, useFactory: () => new FileTrialStore(runsDir()) }],
})
export class TrialsModule {}
