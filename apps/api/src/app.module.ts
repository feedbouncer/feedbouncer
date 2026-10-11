import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './http/health.controller.js';
import { DEPS } from './tokens.js';
import type { AppDeps } from './deps.js';

// Providers are wired explicitly (inject: [DEPS, ...]) rather than through
// constructor type metadata, which the test transformer does not emit.
@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: DEPS, useValue: deps }],
    };
  }
}
