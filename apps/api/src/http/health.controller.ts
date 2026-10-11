// /livez and /healthz keep the contract of the pre-Nest health server
// (scripts/dev-stack/smoke.mjs checks the /healthz body byte for byte).
import { Controller, Get, Head, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { errorFields, runChecks } from '@feedbouncer/service-runtime';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';

@Controller()
export class HealthController {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  @Get('livez')
  @Head('livez')
  livez(@Res() reply: FastifyReply): void {
    void reply.header('cache-control', 'no-store').send({ status: 'ok' });
  }

  @Get('healthz')
  @Head('healthz')
  async healthz(@Res() reply: FastifyReply): Promise<void> {
    const { pool, redis, log } = this.deps;
    const report = await runChecks(
      { postgres: () => pool.query('SELECT 1'), redis: () => redis.ping() },
      {
        timeoutMs: 1_000,
        onFailure: (name, err) =>
          log.warn('health check failed', { check: name, ...errorFields(err) }),
      },
    );
    void reply
      .status(report.status === 'ok' ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(report);
  }
}
