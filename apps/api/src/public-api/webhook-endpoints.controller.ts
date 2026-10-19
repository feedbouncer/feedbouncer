import { lookup } from 'node:dns/promises';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  CreateWebhookEndpointBody,
  encodeCursor,
  ListWebhookDeliveriesQuery,
  PgIdempotency,
  routeSpec,
  UpdateWebhookEndpointBody,
  type RouteSpec,
  type StoredResponse,
} from '@feedbouncer/public-api';
import {
  DeliveryInProgressError,
  EndpointDisabledError,
  EndpointLimitError,
  EventUnavailableError,
  InvalidWebhookUrlError,
  PgWebhookDeliveries,
  PgWebhookEndpoints,
} from '@feedbouncer/webhooks';
import { ApiError, notFound } from '../http/errors.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { runIdempotent } from './idempotent.js';
import { decodePageCursor } from './pagination.js';
import { RequireScope } from './scope.decorator.js';

const resolveAddresses = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((a) => a.address);

/** The messages never carry the URL or any request value. */
function toApiError(err: unknown): unknown {
  if (err instanceof InvalidWebhookUrlError)
    return new ApiError(
      422,
      'invalid_webhook_url',
      `The webhook URL is not allowed: ${err.reason}.`,
      {
        reason: err.reason,
      },
    );
  if (err instanceof EndpointLimitError) return new ApiError(409, 'webhook_endpoint_limit_reached');
  if (err instanceof EndpointDisabledError) return new ApiError(409, 'webhook_endpoint_disabled');
  if (err instanceof EventUnavailableError) return new ApiError(409, 'webhook_event_unavailable');
  if (err instanceof DeliveryInProgressError)
    return new ApiError(409, 'webhook_delivery_in_progress');
  return err;
}

@Controller('v1/webhook-endpoints')
@UseGuards(ApiKeyGuard)
export class PublicWebhookEndpointsController {
  readonly #endpoints: PgWebhookEndpoints;
  readonly #deliveries: PgWebhookDeliveries;
  readonly #idempotency: PgIdempotency;

  constructor(@Inject(DEPS) deps: AppDeps) {
    this.#endpoints = new PgWebhookEndpoints(deps.pool, deps.env.encryption, {
      resolve: resolveAddresses,
      allowedPrivateCidrs: deps.env.webhookAllowedPrivateCidrs,
    });
    this.#deliveries = new PgWebhookDeliveries(deps.pool);
    this.#idempotency = new PgIdempotency(deps.pool);
  }

  @Get()
  @RequireScope('write')
  async list(@Req() req: ApiKeyRequest) {
    return { data: await this.#endpoints.list(req.apiKey.organizationId), nextCursor: null };
  }

  @Post()
  @RequireScope('write')
  create(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() rawBody: unknown,
  ) {
    const spec = routeSpec('createWebhookEndpoint');
    const body = parseBody(CreateWebhookEndpointBody, rawBody);
    void reply.header('cache-control', 'no-store');
    return this.#run(spec, req, reply, {}, body, async () => {
      const { endpoint, secret } = await this.#endpoints.create(req.apiKey, body);
      return { status: 201, body: { endpoint, secret: secret.reveal() } };
    });
  }

  @Get(':id')
  @RequireScope('write')
  async get(@Req() req: ApiKeyRequest, @Param('id') id: string) {
    const endpoint = await this.#endpoints.get(req.apiKey.organizationId, parseUuidOr404(id));
    if (!endpoint) throw notFound();
    return endpoint;
  }

  @Patch(':id')
  @RequireScope('write')
  update(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
  ) {
    const spec = routeSpec('updateWebhookEndpoint');
    const id = parseUuidOr404(rawId);
    const body = parseBody(UpdateWebhookEndpointBody, rawBody);
    return this.#run(spec, req, reply, { id }, body, async () => {
      const endpoint = await this.#endpoints.update(req.apiKey, id, body);
      if (!endpoint) throw notFound();
      return { status: 200, body: endpoint };
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireScope('write')
  async remove(@Req() req: ApiKeyRequest, @Param('id') id: string): Promise<void> {
    if (!(await this.#endpoints.remove(req.apiKey, parseUuidOr404(id)))) throw notFound();
  }

  @Post(':id/rotate-secret')
  @RequireScope('write')
  rotate(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
  ) {
    const spec = routeSpec('rotateWebhookSecret');
    const id = parseUuidOr404(rawId);
    const body = parseBody(spec.body!, rawBody);
    void reply.header('cache-control', 'no-store');
    return this.#run(spec, req, reply, { id }, body, async () => {
      const rotated = await this.#endpoints.rotateSecret(req.apiKey, id);
      if (!rotated) throw notFound();
      return {
        status: 200,
        body: {
          secret: rotated.secret.reveal(),
          previousSecretExpiresAt: rotated.previousSecretExpiresAt,
        },
      };
    });
  }

  @Post(':id/test')
  @RequireScope('write')
  test(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
  ) {
    const spec = routeSpec('testWebhookEndpoint');
    const id = parseUuidOr404(rawId);
    const body = parseBody(spec.body!, rawBody);
    return this.#run(spec, req, reply, { id }, body, async () => {
      const delivery = await this.#deliveries.sendTest(req.apiKey, id);
      if (!delivery) throw notFound();
      return { status: 202, body: delivery };
    });
  }

  @Get(':id/deliveries')
  @RequireScope('write')
  async deliveries(
    @Req() req: ApiKeyRequest,
    @Param('id') rawId: string,
    @Query() rawQuery: unknown,
  ) {
    const id = parseUuidOr404(rawId);
    const q = parseBody(ListWebhookDeliveriesQuery, rawQuery);
    const filters = { endpointId: id, status: q.status };
    const after = decodePageCursor(q.cursor, filters);
    const page = await this.#deliveries.list(
      req.apiKey.organizationId,
      id,
      q.status ? { status: q.status } : {},
      { limit: q.limit, ...(after && { after }) },
    );
    if (!page) throw notFound();
    return { data: page.rows, nextCursor: page.next && encodeCursor(page.next, filters) };
  }

  @Post(':id/deliveries/:deliveryId/redeliver')
  @RequireScope('write')
  redeliver(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') rawId: string,
    @Param('deliveryId') rawDeliveryId: string,
    @Body() rawBody: unknown,
  ) {
    const spec = routeSpec('redeliverWebhookDelivery');
    const id = parseUuidOr404(rawId);
    const deliveryId = parseUuidOr404(rawDeliveryId);
    const body = parseBody(spec.body!, rawBody);
    return this.#run(spec, req, reply, { id, deliveryId }, body, async () => {
      const delivery = await this.#deliveries.redeliver(req.apiKey, id, deliveryId);
      if (!delivery) throw notFound();
      return { status: 202, body: delivery };
    });
  }

  #run(
    spec: RouteSpec,
    req: ApiKeyRequest,
    reply: FastifyReply,
    params: Record<string, string>,
    body: unknown,
    work: () => Promise<StoredResponse>,
  ): Promise<unknown> {
    return runIdempotent(this.#idempotency, req, reply, spec, params, body, () =>
      work().catch((err: unknown) => {
        throw toApiError(err);
      }),
    );
  }
}
