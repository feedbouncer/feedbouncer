import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, MCP_ENV_DOCS } from './config.js';
import { buildToolManifest } from './tool-manifest.js';

const VALID = `fbk_abcdefghij234567_${'A'.repeat(43)}`;

describe('tool manifest', () => {
  it('matches the committed docs/mcp/tools.json', async () => {
    const committed = readFileSync(
      new URL('../../../docs/mcp/tools.json', import.meta.url),
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

  it('documents env defaults that the config parser actually uses', () => {
    const url = MCP_ENV_DOCS.find((e) => e.name === 'FEEDBOUNCER_API_URL');
    expect(loadConfig({ FEEDBOUNCER_API_KEY: VALID }).apiBaseUrl.href).toBe(`${url?.default}/`);
    expect(MCP_ENV_DOCS.find((e) => e.name === 'FEEDBOUNCER_API_KEY')?.required).toBe(true);
  });
});
