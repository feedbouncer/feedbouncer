import { describe, expect, it } from 'vitest';
import { withLogContext } from './log-context.js';
import { createLogger, errorFields, isSecretField, redact } from './logger.js';

describe('createLogger', () => {
  it('writes one JSON object per line with service, level, msg and time', () => {
    const lines: string[] = [];
    createLogger('api', 'info', (l) => lines.push(l)).info('started', { port: 3001 });
    const entry = JSON.parse(lines[0] ?? '');
    expect(entry).toMatchObject({ service: 'api', level: 'info', msg: 'started', port: 3001 });
    expect(typeof entry.time).toBe('string');
  });

  it('drops entries below the configured level', () => {
    const lines: string[] = [];
    const log = createLogger('api', 'warn', (l) => lines.push(l));
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['c', 'd']);
  });

  it('redacts URL credentials in messages and string fields', () => {
    const lines: string[] = [];
    createLogger('api', 'info', (l) => lines.push(l)).info(
      'cannot reach postgresql://u:hunter2@db/x',
      {
        url: 'redis://:hunter2@redis:6379',
      },
    );
    expect(lines[0]).not.toContain('hunter2');
  });
});

describe('redact', () => {
  it('replaces userinfo in URLs', () => {
    expect(redact('postgresql://fb:secret@postgres:5432/db')).toBe(
      'postgresql://[redacted]@postgres:5432/db',
    );
    expect(redact('no url here')).toBe('no url here');
  });

  it('redacts credentials in Authorization headers and bearer tokens', () => {
    expect(redact('failed Authorization: Bearer SENTINEL-BEARER now')).toBe(
      'failed Authorization: Bearer [redacted] now',
    );
    expect(redact('authorization=Basic dXNlcjpwYXNz')).toBe('authorization=Basic [redacted]');
    expect(redact('sent bearer abcdef0123456789')).toBe('sent bearer [redacted]');
    expect(redact('sent bearer s3cr3t')).toBe('sent bearer [redacted]');
    expect(redact('the basic plan is fine')).toBe('the basic plan is fine');
  });

  it('redacts a bearer token with any characters, in every header form', () => {
    const odd = 'ab%2Fcd*ef:gh!ij$kl';
    expect(redact(`Authorization: Bearer ${odd} then`)).toBe(
      'Authorization: Bearer [redacted] then',
    );
    expect(redact(`got bearer ${odd}`)).toBe('got bearer [redacted]');
    expect(redact('Authorization: Token tok_0123456789 ok')).toBe(
      'Authorization: Token [redacted] ok',
    );
    const digest = redact('Authorization: Digest username="bob", realm="r", response="deadbeef"');
    expect(digest).toBe('Authorization: Digest [redacted]');
    expect(redact('Proxy-Authorization: Basic dXNlcjpwYXNz')).toBe(
      'Proxy-Authorization: Basic [redacted]',
    );
    expect(redact('Authorization: rawcredential123 failed here')).not.toContain('rawcredential123');
    expect(redact('Authorization: MyScheme mycredential456')).not.toContain('mycredential456');
    expect(redact('{"authorization":"Bearer sekrit-v4lue"}')).toBe(
      '{"authorization":"Bearer [redacted]"}',
    );
    const escaped = redact(String.raw`{\"authorization\":\"Bearer sekrit-v4lue%21\"}`);
    expect(escaped).not.toContain('sekrit');
    expect(
      redact('x'.repeat(50_000) + ' authorization: ' + 'a '.repeat(20_000)).length,
    ).toBeGreaterThan(0);
  });

  it('masks multi-word and parameterised authorization values', () => {
    const aws = redact(
      'authorization: AWS4-HMAC-SHA256 Credential=AKIA/x, SignedHeaders=host, Signature=deadbeef',
    );
    expect(aws).not.toMatch(/AKIA|SignedHeaders|deadbeef/);
    const oauth = redact(
      'Authorization: OAuth oauth_consumer_key="k", oauth_signature="SECRETSIG"',
    );
    expect(oauth).not.toMatch(/SECRETSIG|oauth_consumer_key/);
    const quoted = redact('Authorization: Bearer "abc def ghi"');
    expect(quoted).toBe('Authorization: Bearer [redacted]');
    const arr = redact("authorization: [ 'Bearer abc' ]");
    expect(arr).not.toContain('abc');
    expect(arr).toContain('Bearer [redacted]');
  });

  it('stays bounded on 200KB adversarial input', () => {
    const inputs = [
      'authorization: ' + 'a '.repeat(100_000),
      'authorization:' + ' '.repeat(200_000) + 'x',
      'Authorization: Bearer '.repeat(9_000),
      'authorization: [ "' + 'a'.repeat(200_000),
    ];
    const start = performance.now();
    for (const input of inputs) {
      const out = redact(input);
      expect(out.length).toBeLessThanOrEqual(input.length + 64);
    }
    expect(performance.now() - start).toBeLessThan(5_000);
  });

  it('redacts the whole userinfo when the password contains @', () => {
    expect(redact('postgres://u:p@ss@db/x')).toBe('postgres://[redacted]@db/x');
  });

  it('redacts the whole userinfo when the password contains /', () => {
    expect(redact('postgres://u:p/ss@db/x')).toBe('postgres://[redacted]@db/x');
  });

  it('redacts every URL in a string without eating text between them', () => {
    expect(redact('a postgres://u:p@ss@db/x and redis://:pw@r:6379 done')).toBe(
      'a postgres://[redacted]@db/x and redis://[redacted]@r:6379 done',
    );
  });

  it('leaves URLs without an @ untouched', () => {
    for (const url of ['http://host/a', 'http://host:80/a/b?x=1', 'http://[::1]:8080/x']) {
      expect(redact(`see ${url} now`)).toBe(`see ${url} now`);
    }
  });

  it('prefers over-redaction when an @ appears in the path or query', () => {
    expect(redact('http://host/a@b')).toBe('http://[redacted]@b');
    expect(redact('https://h/p?email=a@b.c')).toBe('https://[redacted]@b.c');
  });

  it('redacts digit-only passwords containing / ? #', () => {
    for (const url of [
      'postgres://u:123/ab@db/x',
      'postgres://u:12?3@db/x',
      'postgres://u:12#3@db/x',
    ]) {
      const out = redact(url);
      expect(out).toBe('postgres://[redacted]@db/x');
    }
  });

  it('redacts passwords containing quotes, angle brackets, commas or semicolons', () => {
    for (const pw of ['pa"ss', "p'w", 'pw,1', 'pw;1', 'p<w>1']) {
      expect(redact(`postgres://u:${pw}@host/db`)).toBe('postgres://[redacted]@host/db');
    }
  });

  it('never leaks when URLs are joined by commas or semicolons (over-redacts the middle)', () => {
    expect(redact('postgres://u:p@h/x,redis://:pw@r:6379')).toBe('postgres://[redacted]@r:6379');
    expect(redact('http://h/x;redis://:pw@r')).toBe('http://[redacted]@r');
  });

  it('keeps punctuation that follows the last @', () => {
    expect(redact('(postgres://u:pw@db/x), done')).toBe('(postgres://[redacted]@db/x), done');
    expect(redact('url="postgres://u:pw@db/x";')).toBe('url="postgres://[redacted]@db/x";');
  });

  it('masks quoted and JSON secrets', () => {
    expect(redact('password="hunter2" x')).toBe('password="[redacted]" x');
    expect(redact('{"password":"hunter2","a":1}')).toBe('{"password":"[redacted]","a":1}');
    expect(redact("{'password': 'hun ter2'}")).toBe("{'password': '[redacted]'}");
  });

  it('handles escaped quotes inside quoted secrets', () => {
    expect(redact('password="pa\\"ss" x')).toBe('password="[redacted]" x');
    expect(redact("password='pa\\'ss' x")).toBe("password='[redacted]' x");
    expect(redact('{"password":"a\\"b\\\\"}')).toBe('{"password":"[redacted]"}');
  });

  it('stays fast on pathological input', () => {
    const n = 100_000;
    for (const piece of [
      'a',
      ':',
      '@',
      '//',
      'password',
      'password ',
      '//a:',
      'x@//',
      '"',
      "'",
      ',',
      'password="',
      'password="\\',
      'http://a@',
      '//a,',
    ]) {
      const input = piece.repeat(Math.ceil(n / piece.length));
      const started = performance.now();
      redact(input);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it('stops at quotes and angle brackets', () => {
    expect(redact('"postgres://u:pw@db/x" <redis://:pw@r>')).toBe(
      '"postgres://[redacted]@db/x" <redis://[redacted]@r>',
    );
  });

  it('masks key=value secrets in DSNs and query strings', () => {
    expect(redact('host=x password=hunter2 dbname=y')).toBe('host=x password=[redacted] dbname=y');
    expect(redact('postgres://h/db?sslpassword=abc&sslmode=require')).toBe(
      'postgres://h/db?sslpassword=[redacted]&sslmode=require',
    );
    expect(redact('api_key: k123, TOKEN=t0k')).toBe('api_key: [redacted], TOKEN=[redacted]');
  });
});

describe('errorFields', () => {
  it('keeps name and code, redacts the message', () => {
    const err = Object.assign(new Error('connect to postgresql://u:pw@h/db failed'), {
      code: 'ECONNREFUSED',
    });
    expect(errorFields(err)).toEqual({
      error: 'Error',
      errorCode: 'ECONNREFUSED',
      errorMessage: 'connect to postgresql://[redacted]@h/db failed',
      errorClass: null,
    });
  });
  it('handles non-Error throws', () => {
    expect(errorFields('boom')).toEqual({
      error: 'NonError',
      errorCode: null,
      errorMessage: null,
      errorClass: null,
    });
  });
});

describe('field-name redaction', () => {
  it('redacts values of secret-named fields regardless of type or content', () => {
    const lines: string[] = [];
    const log = createLogger('t', 'debug', (l) => lines.push(l));
    log.info('x', {
      accessToken: 'plain-looking-value-1',
      refresh_token: 'plain-looking-value-2',
      webhookSecret: 'plain-looking-value-3',
      password: 'plain-looking-value-4',
      authorization: 'Bearer plain-looking-value-5',
      apiKey: 'plain-looking-value-6',
      FB_ENCRYPTION_KEYS: 'k1:plain-looking-value-7',
      cookie: 'sid=plain-looking-value-8',
      credential: 12345,
      keyId: 'k2026a',
      connectionId: 'c-1',
    });
    const parsed = JSON.parse(lines[0]!);
    for (const v of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      expect(lines[0]).not.toContain(`plain-looking-value-${v}`);
    }
    expect(parsed.credential).toBe('[redacted]');
    expect(parsed.keyId).toBe('k2026a');
    expect(parsed.connectionId).toBe('c-1');
  });

  it('does not redact harmless fields that merely contain a secret-looking fragment', () => {
    const lines: string[] = [];
    const log = createLogger('t', 'debug', (l) => lines.push(l));
    log.info('x', {
      bypass: true,
      passCount: 3,
      tokenExpiresAt: '2026-10-11T00:00:00Z',
      credentialKind: 'oauth',
      secretLength: 32,
      compass: 'north',
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      bypass: true,
      passCount: 3,
      tokenExpiresAt: '2026-10-11T00:00:00Z',
      credentialKind: 'oauth',
      secretLength: 32,
      compass: 'north',
    });
  });

  it('redacts secret-named fields in every casing style', () => {
    const lines: string[] = [];
    const log = createLogger('t', 'debug', (l) => lines.push(l));
    log.info('x', {
      'x-api-key': 'v1',
      APIKey: 'v2',
      db_password: 'v3',
      privateKey: 'v4',
      accesstoken: 'v5',
      tokenValue: 'v6',
      Passwd: 'v7',
    });
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']) {
      expect(lines[0]).not.toContain(`"${v}"`);
    }
  });

  it('redacts FB_ENCRYPTION_KEYS=... pairs inside messages', () => {
    expect(redact('bad config FB_ENCRYPTION_KEYS=k1:QUJD')).not.toContain('QUJD');
  });
});

it('exports isSecretField with the logger rules', () => {
  expect(isSecretField('accessToken')).toBe(true);
  expect(isSecretField('refresh_token')).toBe(true);
  expect(isSecretField('tokenExpiresAt')).toBe(false);
  expect(isSecretField('commentId')).toBe(false);
});

it('core keys cannot be overridden', () => {
  const lines: string[] = [];
  const log = createLogger('api', 'info', (l) => lines.push(l));
  log.info('real', {
    msg: 'fake',
    level: 'debug',
    service: 'x',
    time: 'then',
    tenant_id: 'a"}\n{"level":"error',
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]!.includes('\n')).toBe(false);
  const o = JSON.parse(lines[0]!);
  expect(o).toMatchObject({ msg: 'real', level: 'info', service: 'api' });
  expect(o.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

it('a throwing sink never throws to the caller', () => {
  const log = createLogger('api', 'info', () => {
    throw new Error('EPIPE');
  });
  expect(() => log.error('x')).not.toThrow();
});

it('errorFields carries a stable code and class', () => {
  const e = Object.assign(new Error('boom password=hunter2'), {
    code: 'upstream_5xx',
    errorClass: 'retryable',
  });
  expect(errorFields(e)).toEqual({
    error: 'Error',
    errorCode: 'upstream_5xx',
    errorMessage: 'boom password=[redacted]',
    errorClass: 'retryable',
  });
  expect(errorFields(new Error('x')).errorClass).toBeNull();
});

describe('correlation keys', () => {
  const hostile = 'a"}\n{"level":"error';

  it('bound context wins over caller fields and spoofed span ids', () => {
    const lines: string[] = [];
    const log = createLogger('api', 'info', (l) => lines.push(l));
    withLogContext({ tenant_id: 'org-1' }, () =>
      log.info('x', { tenant_id: hostile, trace_id: 'spoof', job_id: 'j-9' }),
    );
    expect(lines[0]!.includes('\n')).toBe(false);
    const o = JSON.parse(lines[0]!);
    expect(o.tenant_id).toBe('org-1');
    expect(o.trace_id).toBe('spoof'); // no active span: a safe caller id is kept
    expect(o.job_id).toBe('j-9');
    expect(o.level).toBe('info');
  });

  it('bound context overrides even a safe caller value', () => {
    const lines: string[] = [];
    const log = createLogger('api', 'info', (l) => lines.push(l));
    withLogContext({ tenant_id: 'org-1' }, () => log.info('x', { tenant_id: 'org-2' }));
    expect(JSON.parse(lines[0]!).tenant_id).toBe('org-1');
  });

  it('outside a context drops hostile caller ids and keeps safe ones', () => {
    const lines: string[] = [];
    const log = createLogger('api', 'info', (l) => lines.push(l));
    log.info('x', { tenant_id: hostile, trace_id: 'bad id', request_id: 'req-1' });
    const o = JSON.parse(lines[0]!);
    expect(o).not.toHaveProperty('tenant_id');
    expect(o).not.toHaveProperty('trace_id');
    expect(o.request_id).toBe('req-1');
  });
});
