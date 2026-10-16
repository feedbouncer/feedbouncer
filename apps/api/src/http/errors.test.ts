import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { createLogger } from '@feedbouncer/service-runtime';
import { ApiError, ApiErrorFilter, errorBody, notFound } from './errors.js';

function fakeReply() {
  const sent: { status?: number; headers: Record<string, string>; body?: unknown } = {
    headers: {},
  };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { sent, host };
}

function run(err: unknown) {
  const lines: string[] = [];
  const filter = new ApiErrorFilter(createLogger('api-test', 'debug', (l) => lines.push(l)));
  const { sent, host } = fakeReply();
  filter.catch(err, host);
  return { sent, lines };
}

describe('ApiError', () => {
  it('uses a plain default message per code', () => {
    expect(new ApiError(403, 'invalid_origin').message).toBe('Request origin is not allowed.');
    expect(notFound().status).toBe(404);
    expect(notFound().code).toBe('not_found');
    expect(notFound().message).toBe('Not found.');
  });
  it('accepts a custom message', () => {
    expect(new ApiError(400, 'invalid_request', 'Bad name.').message).toBe('Bad name.');
  });
});

describe('ApiError details', () => {
  it('are merged into the envelope next to code and message', () => {
    const e = new ApiError(422, 'text_too_long', undefined, { max: 2200 });
    expect(errorBody(e)).toEqual({
      error: { code: 'text_too_long', message: e.message, max: 2200 },
    });
  });
});

describe('missing_permission', () => {
  it('names the missing platform permission in the envelope', () => {
    const e = new ApiError(409, 'missing_permission', undefined, {
      permission: 'pages_manage_engagement',
    });
    expect(errorBody(e)).toEqual({
      error: {
        code: 'missing_permission',
        message: 'Missing platform permission.',
        permission: 'pages_manage_engagement',
      },
    });
  });
});

describe('ApiErrorFilter', () => {
  it('converts an ApiError into the envelope with its status', () => {
    const { sent, lines } = run(new ApiError(403, 'invalid_origin'));
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({
      error: { code: 'invalid_origin', message: new ApiError(403, 'invalid_origin').message },
    });
    expect(sent.headers['cache-control']).toBe('no-store');
    expect(lines).toEqual([]);
  });

  it('hides unexpected errors behind 500 internal_error and logs them redacted', () => {
    const { sent, lines } = run(new Error('secret postgresql://u:p@h/db'));
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({
      error: { code: 'internal_error', message: 'Something went wrong.' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[redacted]');
    expect(lines[0]).not.toContain('u:p');
  });

  it('hides non-Error throws too', () => {
    const { sent, lines } = run('a string');
    expect(sent.status).toBe(500);
    expect(lines).toHaveLength(1);
  });

  it("converts Nest's NotFoundException (unknown route) into 404 not_found", () => {
    const { sent } = run(new NotFoundException('Cannot GET /nope?token=abc'));
    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('converts other 4xx HttpExceptions into 400 invalid_request without their text', () => {
    const { sent } = run(new BadRequestException('Unexpected token } in JSON at position 7'));
    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      error: { code: 'invalid_request', message: expect.any(String) as string },
    });
    expect(JSON.stringify(sent.body)).not.toContain('Unexpected token');
    expect(run(new ForbiddenException()).sent.status).toBe(400);
  });

  it('keeps 413 and 415 statuses', () => {
    expect(run(new HttpException('too big', 413)).sent).toMatchObject({
      status: 413,
      body: { error: { code: 'invalid_request' } },
    });
    expect(run(new HttpException('Unsupported Media Type: text/plain', 415)).sent).toMatchObject({
      status: 415,
      body: { error: { code: 'invalid_request' } },
    });
  });

  it('treats 5xx HttpExceptions as internal errors', () => {
    const { sent, lines } = run(new HttpException('boom', 502));
    expect(sent.status).toBe(500);
    expect(lines).toHaveLength(1);
  });
});
