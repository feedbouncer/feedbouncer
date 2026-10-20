import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';

/**
 * Fastify's JSON parser decodes invalid UTF-8 into replacement characters, so
 * mangled text would be accepted as something else. This one refuses it, then
 * hands the text to the default parser (proto and constructor poisoning are errors).
 */
export function registerStrictJsonParser(fastify: FastifyInstance): void {
  const parseJson = fastify.getDefaultJsonParser('error', 'error');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    let text: string;
    try {
      text = utf8.decode(body as Buffer);
    } catch {
      done(new ApiError(400, 'invalid_request', 'Request body is not valid UTF-8.'), undefined);
      return;
    }
    parseJson(req, text, done);
  });
}
