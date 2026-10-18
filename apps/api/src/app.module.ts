import { Module, type DynamicModule } from '@nestjs/common';
import { PgBackfillStore } from '@feedbouncer/comments';
import { PgApiKeys } from '@feedbouncer/public-api';
import { Reflector } from '@nestjs/core';
import { createAccountDeletionHooks } from './auth/account-deletion.js';
import { createAuth, type AuthHooks } from './auth/auth.js';
import { AuthProxyController } from './auth/auth-proxy.controller.js';
import { createAuthEmails, type AuthEmails } from './auth/emails.js';
import { createAuthRateLimits } from './auth/rate-limit.js';
import { ApiKeyGuard } from './public-api/api-key.guard.js';
import { OpenApiController } from './public-api/openapi.controller.js';
import { createPublicApiLimits } from './public-api/rate-limit.js';
import { SessionGuard } from './auth/session.guard.js';
import { SignUpController } from './auth/sign-up.controller.js';
import { ActionsController } from './actions/actions.controller.js';
import { ActionsService } from './actions/actions.service.js';
import { ReviewController } from './actions/review.controller.js';
import { AlertChannelsController } from './alerts/alert-channels.controller.js';
import { AlertRecipientsController } from './alerts/alert-recipients.controller.js';
import { AlertsService } from './alerts/alerts.service.js';
import { BrandAlertsController } from './alerts/brand-alerts.controller.js';
import { ApiKeysController } from './api-keys/api-keys.controller.js';
import { ApiKeysService } from './api-keys/api-keys.service.js';
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
import { HiddenTodayController } from './hidden-today/hidden-today.controller.js';
import { HiddenTodayService } from './hidden-today/hidden-today.service.js';
import { MeHiddenTodayController } from './hidden-today/me-hidden-today.controller.js';
import { OrgCommentsController } from './org-comments/org-comments.controller.js';
import { OrgCommentsService } from './org-comments/org-comments.service.js';
import { HealthController } from './http/health.controller.js';
import {
  InvitationsController,
  OrgInvitationsController,
} from './invitations/invitations.controller.js';
import { InvitationsService } from './invitations/invitations.service.js';
import { RoleGrantsController } from './role-grants/role-grants.controller.js';
import { RoleGrantsService } from './role-grants/role-grants.service.js';
import { MembersController } from './members/members.controller.js';
import { MembersService } from './members/members.service.js';
import { MeController } from './me/me.controller.js';
import { ClassifierController } from './classifier/classifier.controller.js';
import { ClassifierService } from './classifier/classifier.service.js';
import { PoliciesController } from './policies/policies.controller.js';
import { PoliciesService } from './policies/policies.service.js';
import { ActivityController } from './rules/activity.controller.js';
import { DomainsController } from './rules/domains.controller.js';
import { RulesController } from './rules/rules.controller.js';
import { RulesService } from './rules/rules.service.js';
import { OrgController, OrgsListController } from './orgs/orgs.controller.js';
import { TagsController } from './tags/tags.controller.js';
import { TagsService } from './tags/tags.service.js';
import { ReviewModeController } from './review-mode/review-mode.controller.js';
import { ReviewModeService } from './review-mode/review-mode.service.js';
import { SuggestionsController } from './review-mode/suggestions.controller.js';
import { OrgsService } from './orgs/orgs.service.js';
import { MeReportsController } from './reports/me-reports.controller.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { OrgAccessGuard } from './tenancy/org-access.guard.js';
import {
  ACCOUNT_DELETION,
  API_KEYS,
  AUTH,
  AUTH_EMAILS,
  BACKFILL_STORE,
  COMMENTS,
  CONNECTOR_STACK,
  DEPS,
  JOB_PRODUCER,
  PUBLIC_API_LIMITS,
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
        MeHiddenTodayController,
        OrgsListController,
        OrgController,
        BrandsController,
        ConnectionHealthController,
        ConnectionsController,
        OAuthConnectController,
        OAuthCallbackController,
        CommentsController,
        OrgCommentsController,
        TagsController,
        AdsController,
        RulesController,
        ActionsController,
        ReviewController,
        HiddenTodayController,
        ReviewModeController,
        SuggestionsController,
        DomainsController,
        ActivityController,
        ClassifierController,
        PoliciesController,
        MembersController,
        RoleGrantsController,
        OrgInvitationsController,
        InvitationsController,
        AlertChannelsController,
        BrandAlertsController,
        AlertRecipientsController,
        ReportsController,
        MeReportsController,
        ApiKeysController,
        OpenApiController,
        ...(deps.extraControllers ?? []),
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
        OrgCommentsService,
        TagsService,
        AdsService,
        RulesService,
        ActionsService,
        HiddenTodayService,
        ReviewModeService,
        ClassifierService,
        PoliciesService,
        MembersService,
        RoleGrantsService,
        InvitationsService,
        AlertsService,
        ReportsService,
        ApiKeysService,
        ApiKeyGuard,
        { provide: DEPS, useValue: deps },
        // Null when Facebook is not configured; the services answer 404 then.
        { provide: CONNECTOR_STACK, useValue: deps.connectors?.stack ?? null },
        { provide: JOB_PRODUCER, useValue: deps.producer },
        { provide: COMMENTS, useValue: deps.comments },
        { provide: API_KEYS, useValue: new PgApiKeys(deps.pool) },
        { provide: BACKFILL_STORE, useValue: new PgBackfillStore(deps.pool) },
        {
          provide: AUTH_EMAILS,
          inject: [DEPS],
          useFactory: (d: AppDeps) =>
            createAuthEmails(d.mailer, d.log, d.env.publicWebUrl.origin, d.env.betaSupportEmail),
        },
        {
          provide: RATE_LIMITS,
          inject: [DEPS],
          useFactory: (d: AppDeps) => createAuthRateLimits(d.redis, d.redisKeyPrefix),
        },
        {
          provide: PUBLIC_API_LIMITS,
          inject: [DEPS],
          useFactory: (d: AppDeps) =>
            createPublicApiLimits(d.redis, d.redisKeyPrefix, d.env.publicApiRateLimitPerMinute),
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
