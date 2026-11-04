import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LiteLlmClient } from '../litellm/litellm.client';
import { APP_CONFIG, readAppConfig } from './app-config';

/** The environment settings, the database and the LiteLLM client, shared by every module. */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [{ provide: APP_CONFIG, useFactory: () => readAppConfig() }, LiteLlmClient],
  exports: [APP_CONFIG, LiteLlmClient, DatabaseModule],
})
export class CoreModule {}
