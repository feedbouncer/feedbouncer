import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const VALID = `fbk_abcdefghij234567_${'A'.repeat(43)}`;

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({ FEEDBOUNCER_API_KEY: VALID });
    expect(cfg.apiBaseUrl.href).toBe('http://127.0.0.1:3001/');
    expect(cfg.apiKey.reveal()).toBe(VALID);
    expect(cfg.requestTimeoutMs).toBe(10_000);
    expect(cfg.replyWaitMs).toBe(15_000);
  });

  it('rejects a missing or malformed key without echoing it', () => {
    expect(() => loadConfig({ FEEDBOUNCER_API_KEY: 'nope' })).toThrow(/missing or malformed/);
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ FEEDBOUNCER_API_KEY: VALID + '!' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('fbk_');
    }
  });

  it('allows https anywhere and http only on loopback', () => {
    const env = { FEEDBOUNCER_API_KEY: VALID };
    expect(
      loadConfig({ ...env, FEEDBOUNCER_API_URL: 'https://api.example.com' }).apiBaseUrl.host,
    ).toBe('api.example.com');
    for (const host of ['localhost:3001', '127.0.0.1', '[::1]:3001']) {
      expect(() => loadConfig({ ...env, FEEDBOUNCER_API_URL: `http://${host}` })).not.toThrow();
    }
    expect(() => loadConfig({ ...env, FEEDBOUNCER_API_URL: 'http://api.example.com' })).toThrow(
      /https/,
    );
    expect(() => loadConfig({ ...env, FEEDBOUNCER_API_URL: 'ftp://localhost' })).toThrow(/https/);
    expect(() => loadConfig({ ...env, FEEDBOUNCER_API_URL: 'not a url' })).toThrow(ConfigError);
  });

  it.each(['https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f'])('rejects %s', (url) => {
    expect(() => loadConfig({ FEEDBOUNCER_API_KEY: VALID, FEEDBOUNCER_API_URL: url })).toThrow(
      ConfigError,
    );
  });
});
