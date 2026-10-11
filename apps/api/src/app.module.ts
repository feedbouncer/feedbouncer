import { Module, type DynamicModule } from '@nestjs/common';
import { createAuth, type AuthHooks } from './auth/auth.js';
import { AuthProxyController } from './auth/auth-proxy.controller.js';
import { createAuthEmails, type AuthEmails } from './auth/emails.js';
import { createAuthRateLimits } from './auth/rate-limit.js';
import { SignUpController } from './auth/sign-up.controller.js';
import { HealthController } from './http/health.controller.js';
import { ACCOUNT_DELETION, AUTH, AUTH_EMAILS, DEPS, RATE_LIMITS } from './tokens.js';
import type { AppDeps } from './deps.js';

// Until account deletion has its own service, nothing blocks a deletion.
const allowAccountDeletion: AuthHooks = { beforeDeleteUser: async () => {} };

// Providers are wired explicitly (inject: [DEPS, ...]) rather than through
// constructor type metadata, which the test transformer does not emit.
@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, SignUpController, AuthProxyController],
      providers: [
        { provide: DEPS, useValue: deps },
        {
          provide: AUTH_EMAILS,
          inject: [DEPS],
          useFactory: (d: AppDeps) => createAuthEmails(d.mailer, d.log, d.env.publicWebUrl.origin),
        },
        {
          provide: RATE_LIMITS,
          inject: [DEPS],
          useFactory: (d: AppDeps) => createAuthRateLimits(d.redis, d.redisKeyPrefix),
        },
        { provide: ACCOUNT_DELETION, useValue: allowAccountDeletion },
        {
          provide: AUTH,
          inject: [DEPS, AUTH_EMAILS, ACCOUNT_DELETION],
          useFactory: (d: AppDeps, e: AuthEmails, del: AuthHooks) => createAuth(d, e, del),
        },
      ],
    };
  }
}
