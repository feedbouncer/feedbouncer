import { Module, type DynamicModule } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createAccountDeletionHooks } from './auth/account-deletion.js';
import { createAuth, type AuthHooks } from './auth/auth.js';
import { AuthProxyController } from './auth/auth-proxy.controller.js';
import { createAuthEmails, type AuthEmails } from './auth/emails.js';
import { createAuthRateLimits } from './auth/rate-limit.js';
import { SessionGuard } from './auth/session.guard.js';
import { SignUpController } from './auth/sign-up.controller.js';
import { BrandsController } from './brands/brands.controller.js';
import { BrandsService } from './brands/brands.service.js';
import { ConnectionHealthController } from './connections/connection-health.controller.js';
import { ConnectionHealthService } from './connections/connection-health.service.js';
import { HealthController } from './http/health.controller.js';
import {
  InvitationsController,
  OrgInvitationsController,
} from './invitations/invitations.controller.js';
import { InvitationsService } from './invitations/invitations.service.js';
import { MembersController } from './members/members.controller.js';
import { MembersService } from './members/members.service.js';
import { MeController } from './me/me.controller.js';
import { OrgController, OrgsListController } from './orgs/orgs.controller.js';
import { OrgsService } from './orgs/orgs.service.js';
import { OrgAccessGuard } from './tenancy/org-access.guard.js';
import { ACCOUNT_DELETION, AUTH, AUTH_EMAILS, DEPS, RATE_LIMITS } from './tokens.js';
import type { AppDeps } from './deps.js';

// Providers are wired explicitly (inject: [DEPS, ...]) rather than through
// constructor type metadata, which the test transformer does not emit.
@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        SignUpController,
        AuthProxyController,
        MeController,
        OrgsListController,
        OrgController,
        BrandsController,
        ConnectionHealthController,
        MembersController,
        OrgInvitationsController,
        InvitationsController,
      ],
      providers: [
        Reflector,
        SessionGuard,
        OrgAccessGuard,
        OrgsService,
        BrandsService,
        ConnectionHealthService,
        MembersService,
        InvitationsService,
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
        {
          provide: ACCOUNT_DELETION,
          inject: [DEPS],
          useFactory: (d: AppDeps) => createAccountDeletionHooks(d.pool),
        },
        {
          provide: AUTH,
          inject: [DEPS, AUTH_EMAILS, ACCOUNT_DELETION],
          useFactory: (d: AppDeps, e: AuthEmails, del: AuthHooks) => createAuth(d, e, del),
        },
      ],
    };
  }
}
