import { Module, type DynamicModule } from '@nestjs/common';
import { PgBackfillStore } from '@feedbouncer/comments';
import { Reflector } from '@nestjs/core';
import { createAccountDeletionHooks } from './auth/account-deletion.js';
import { createAuth, type AuthHooks } from './auth/auth.js';
import { AuthProxyController } from './auth/auth-proxy.controller.js';
import { createAuthEmails, type AuthEmails } from './auth/emails.js';
import { createAuthRateLimits } from './auth/rate-limit.js';
import { SessionGuard } from './auth/session.guard.js';
import { SignUpController } from './auth/sign-up.controller.js';
import { AdsController } from './ads/ads.controller.js';
import { AdsService } from './ads/ads.service.js';
import { BrandsController } from './brands/brands.controller.js';
import { BrandsService } from './brands/brands.service.js';
import { CommentsController } from './comments/comments.controller.js';
import { CommentsService } from './comments/comments.service.js';
import { ConnectionHealthController } from './connections/connection-health.controller.js';
import { ConnectionHealthService } from './connections/connection-health.service.js';
import { ConnectionsController } from './connections/connections.controller.js';
import { ConnectionsService } from './connections/connections.service.js';
import { ConnectablePlatformPipe } from './connections/connectable-platform.pipe.js';
import {
  OAuthCallbackController,
  OAuthConnectController,
} from './connections/oauth-connect.controller.js';
import { OAuthConnectService } from './connections/oauth-connect.service.js';
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
import {
  ACCOUNT_DELETION,
  AUTH,
  AUTH_EMAILS,
  BACKFILL_STORE,
  COMMENTS,
  CONNECTOR_STACK,
  DEPS,
  JOB_PRODUCER,
  RATE_LIMITS,
} from './tokens.js';
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
        ConnectionsController,
        OAuthConnectController,
        OAuthCallbackController,
        CommentsController,
        AdsController,
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
        ConnectionsService,
        OAuthConnectService,
        ConnectablePlatformPipe,
        CommentsService,
        AdsService,
        MembersService,
        InvitationsService,
        { provide: DEPS, useValue: deps },
        // Null when Facebook is not configured; the services answer 404 then.
        { provide: CONNECTOR_STACK, useValue: deps.connectors?.stack ?? null },
        { provide: JOB_PRODUCER, useValue: deps.producer },
        { provide: COMMENTS, useValue: deps.comments },
        { provide: BACKFILL_STORE, useValue: new PgBackfillStore(deps.pool) },
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
