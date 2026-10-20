import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { registerStrictJsonParser } from './json-parser.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ bodyLimit: 1024 });
  registerStrictJsonParser(app);
  app.setErrorHandler((err, _req, reply) => {
    const e = err instanceof ApiError ? err : null;
    void reply
      .status(e?.status ?? (err as { statusCode?: number }).statusCode ?? 500)
      .send({ code: e?.code ?? null, message: e?.message ?? null });
  });
  app.post('/echo', async (req) => ({ body: req.body }));
  await app.ready();
});
afterAll(() => app.close());

const post = (payload: string | Buffer) =>
  app.inject({
    method: 'POST',
    url: '/echo',
    headers: { 'content-type': 'application/json' },
    payload,
  });

describe('strict JSON parser', () => {
  it('parses valid UTF-8, including emoji and escapes', async () => {
    const r = await post(Buffer.from('{"text":"hi 😀 \\u00e9"}', 'utf8'));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ body: { text: 'hi 😀 é' } });
  });

  it('rejects bytes that are not valid UTF-8 instead of substituting replacement characters', async () => {
    const r = await post(
      Buffer.from([...Buffer.from('{"text":"'), 0xff, 0xfe, ...Buffer.from('"}')]),
    );
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({
      code: 'invalid_request',
      message: 'Request body is not valid UTF-8.',
    });
  });

  it('keeps prototype and constructor poisoning protection', async () => {
    for (const body of ['{"__proto__":{"x":1}}', '{"constructor":{"prototype":{"x":1}}}']) {
      expect((await post(body)).statusCode).toBe(400);
    }
  });

  it('rejects malformed and empty JSON with 400', async () => {
    expect((await post('{"text":')).statusCode).toBe(400);
    expect((await post('')).statusCode).toBe(400);
  });

  it('keeps the body limit', async () => {
    expect((await post(`{"text":"${'a'.repeat(2048)}"}`)).statusCode).toBe(413);
  });
});
