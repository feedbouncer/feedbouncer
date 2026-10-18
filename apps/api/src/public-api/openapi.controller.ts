import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { buildOpenApiDocument } from './openapi.js';

@Controller('v1')
export class OpenApiController {
  readonly #document = buildOpenApiDocument();

  @Get('openapi.json')
  openApi(@Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'public, max-age=300');
    return this.#document;
  }
}
