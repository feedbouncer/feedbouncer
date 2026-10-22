import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, MCP_ENV_DOCS } from '../config.js';
import { buildToolManifest } from './tool-manifest.js';

const VALID = `fbk_abcdefghij234567_${'A'.repeat(43)}`;

describe('tool manifest', () => {
  it('matches the committed docs/mcp/tools.json', async () => {
    const committed = readFileSync(
      new URL('../../../../docs/mcp/tools.json', import.meta.url),
      'utf8',
    );
    expect(
      `${JSON.stringify(await buildToolManifest(), null, 2)}\n`,
      'docs/mcp/tools.json is stale: run pnpm --filter @feedbouncer/mcp tools:write',
    ).toBe(committed);
  });

  it('lists the seven tools, each with input and output schemas', async () => {
    const m = await buildToolManifest();
    expect(m.tools.map((t) => t.name)).toEqual([
      'list_inbox',
      'propose_rule_change',
      'read_rules',
      'reply_to_comment',
      'search_inbox',
      'set_comment_visibility',
      'summarize_period',
    ]);
    for (const t of m.tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object' });
      expect(t.outputSchema).toMatchObject({ type: 'object' });
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  describe('documented environment rules', () => {
    const doc = (name: string) => MCP_ENV_DOCS.find((e) => e.name === name)!;
    const withUrl = (url: string) => () =>
      loadConfig({ FEEDBOUNCER_API_KEY: VALID, FEEDBOUNCER_API_URL: url });
    const rule = doc('FEEDBOUNCER_API_URL').rule;

    it('requires the key, shaped as the rule describes', () => {
      expect(doc('FEEDBOUNCER_API_KEY').required).toBe(true);
      expect(() => loadConfig({})).toThrow(ConfigError);
      const [, prefix, secret] = /fbk_<(\d+) characters>_<(\d+) characters>/.exec(
        doc('FEEDBOUNCER_API_KEY').rule,
      )!;
      const key = (a: number, b: number) => `fbk_${'a'.repeat(a)}_${'A'.repeat(b)}`;
      expect(() => loadConfig({ FEEDBOUNCER_API_KEY: key(+prefix!, +secret!) })).not.toThrow();
      expect(() => loadConfig({ FEEDBOUNCER_API_KEY: key(+prefix! - 1, +secret!) })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ FEEDBOUNCER_API_KEY: key(+prefix!, +secret! + 1) })).toThrow(
        ConfigError,
      );
    });

    it('uses the documented default URL when the variable is unset or blank', () => {
      const url = doc('FEEDBOUNCER_API_URL');
      expect(rule).toContain('blank uses the default');
      for (const raw of [undefined, '', '   ']) {
        const cfg = loadConfig({ FEEDBOUNCER_API_KEY: VALID, FEEDBOUNCER_API_URL: raw });
        expect(cfg.apiBaseUrl.href).toBe(`${url.default}/`);
      }
    });

    it('requires https except on the loopback hosts it lists', () => {
      expect(withUrl('https://api.example.com')).not.toThrow();
      expect(withUrl('http://api.example.com')).toThrow(/https/);
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        expect(rule).toContain(host);
        expect(withUrl(`http://${host}:3001`)).not.toThrow();
      }
    });

    it('rejects credentials, a query string and a fragment', () => {
      expect(rule).toContain('no credentials, query string or fragment');
      for (const url of ['https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f']) {
        expect(withUrl(url), url).toThrow(ConfigError);
      }
    });
  });
});
