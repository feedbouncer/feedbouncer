import { Module, type DynamicModule } from '@nestjs/common';
import { PgBackfillStore } from '@feedbouncer/comments';
import { PgApiKeys } from '@feedbouncer/public-api';
import { PgPrivacyRequestStore } from '@feedbouncer/privacy';
import { PgScanStore } from '@feedbouncer/scan';
import { Reflector } from '@nestjs/core';
import { createAccountDeletionHooks } from './auth/account-deletion.js';
import { createAuth, type AuthHooks } from './auth/auth.js';
import { AuthProxyController } from './auth/auth-proxy.controller.js';
import { createAuthEmails, type AuthEmails } from './auth/emails.js';
import { createAuthRateLimits } from './auth/rate-limit.js';
import { ApiKeyGuard } from './public-api/api-key.guard.js';
import { PublicCommentsController } from './public-api/comments.controller.js';
import { PublicFlaggedItemsController } from './public-api/flagged-items.controller.js';
import { PublicModerationController } from './public-api/moderation.controller.js';
import { PublicModerationCheckController } from './public-api/moderation-check.controller.js';
import { ModerationCheckClient } from './public-api/moderation-check.client.js';
import { ModerationCheckService } from './public-api/moderation-check.service.js';
import { PublicRepliesController } from './public-api/replies.controller.js';
import { PublicActionsController } from './public-api/actions.controller.js';
import { PublicKeyController } from './public-api/key.controller.js';
import { PublicSummaryController } from './public-api/summary.controller.js';
import { PublicRulesController } from './public-api/rules.controller.js';
import { PublicRuleProposalsService } from './public-api/rule-proposals.service.js';
import { PublicModerationService } from './public-api/moderation.service.js';
import { PublicWebhookEndpointsController } from './public-api/webhook-endpoints.controller.js';
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
import { PrivacyController } from './privacy/privacy.controller.js';
import { PrivacyService } from './privacy/privacy.service.js';
import { ActivityController } from './rules/activity.controller.js';
import { DomainsController } from './rules/domains.controller.js';
import { RuleChangesController } from './rule-changes/rule-changes.controller.js';
import { RuleChangesService } from './rule-changes/rule-changes.service.js';
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
import { ScanController, ScanEnabledGuard } from './scan/scan.controller.js';
import { ScanOAuthService } from './scan/scan-oauth.service.js';
import { createScanRateLimits } from './scan/scan-rate-limit.js';
import { ScanQueueClient } from './scan/scan-queue.client.js';
import { ScanService } from './scan/scan.service.js';
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
  MODERATION_CHECK_CLIENT,
  PRIVACY_QUEUE_CLIENT,
  PRIVACY_REQUESTS,
  PUBLIC_API_LIMITS,
  RATE_LIMITS,
  SCAN_LIMITS,
  SCAN_QUEUE_CLIENT,
  SCAN_STORE,
} from './tokens.js';
import type { AppDeps } from './deps.js';
import { PrivacyQueueClient } from './privacy/privacy-queue.client.js';

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
        RuleChangesController,
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
        PrivacyController,
        OpenApiController,
        PublicCommentsController,
        PublicFlaggedItemsController,
        PublicModerationController,
        PublicModerationCheckController,
        PublicRepliesController,
        PublicActionsController,
        PublicKeyController,
        PublicSummaryController,
        PublicRulesController,
        PublicWebhookEndpointsController,
        ScanController,
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
        RuleChangesService,
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
        PrivacyService,
        ApiKeyGuard,
        PublicModerationService,
        PublicRuleProposalsService,
        ModerationCheckService,
        ScanEnabledGuard,
        ScanOAuthService,
        ScanService,
        { provide: DEPS, useValue: deps },
        // Null when Facebook is not configured; the services answer 404 then.
        { provide: CONNECTOR_STACK, useValue: deps.connectors?.stack ?? null },
        { provide: JOB_PRODUCER, useValue: deps.producer },
        { provide: COMMENTS, useValue: deps.comments },
        { provide: API_KEYS, useValue: new PgApiKeys(deps.pool) },
        {
          provide: PRIVACY_REQUESTS,
          inject: [DEPS],
          useFactory: (d: AppDeps) => new PgPrivacyRequestStore(d.pool, d.env.encryption),
        },
        {
          // Stopped by Nest (onModuleDestroy).
          provide: PRIVACY_QUEUE_CLIENT,
          inject: [DEPS],
          useFactory: (d: AppDeps) =>
            new PrivacyQueueClient({
              redisUrl: d.env.redisUrl.href,
              prefix: d.env.jobs.prefix,
              log: d.log,
            }),
        },
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
          provide: SCAN_STORE,
          inject: [DEPS],
          useFactory: (d: AppDeps) => new PgScanStore(d.pool),
        },
        {
          provide: SCAN_LIMITS,
          inject: [DEPS],
          useFactory: (d: AppDeps) => createScanRateLimits(d.redis, d.redisKeyPrefix),
        },
        {
          // Stopped by Nest (onModuleDestroy).
          provide: SCAN_QUEUE_CLIENT,
          inject: [DEPS],
          useFactory: (d: AppDeps) =>
            new ScanQueueClient({
              redisUrl: d.env.redisUrl.href,
              prefix: d.env.jobs.prefix,
              log: d.log,
            }),
        },
        {
          provide: PUBLIC_API_LIMITS,
          inject: [DEPS],
          useFactory: (d: AppDeps) =>
            createPublicApiLimits(d.redis, d.redisKeyPrefix, d.env.publicApiRateLimitPerMinute),
        },
        {
          // Started and stopped by Nest (onModuleInit / onModuleDestroy).
          provide: MODERATION_CHECK_CLIENT,
          inject: [DEPS],
          useFactory: (d: AppDeps) =>
            new ModerationCheckClient({
              redisUrl: d.env.redisUrl.href,
              prefix: d.env.jobs.prefix,
              log: d.log,
            }),
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
