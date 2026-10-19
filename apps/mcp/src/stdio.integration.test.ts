// The built server (dist/main.js) as an MCP client launches it: a child process over stdio.
// `pnpm test:integration` builds dist before running this file.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startLiveApi, type LiveApi, type Tenant } from './testing/live-api.js';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let live: LiveApi;
let A: Tenant;

const childEnv = (key: string): Record<string, string> => ({
  FEEDBOUNCER_API_URL: live.url,
  FEEDBOUNCER_API_KEY: key,
});

function run(key: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], { env: childEnv(key) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

beforeAll(async () => {
  if (!existsSync(MAIN)) throw new Error(`${MAIN} is missing: run pnpm build first`);
  live = await startLiveApi();
  A = await live.tenant('stdio');
});
afterAll(() => live?.close());

describe('feedbouncer-mcp over stdio', () => {
  it('starts with a valid key and lists the seven tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN],
      env: childEnv(A.writeKey.token),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'list_inbox',
        'propose_rule_change',
        'read_rules',
        'reply_to_comment',
        'search_inbox',
        'set_comment_visibility',
        'summarize_period',
      ]);
      const r = await client.callTool({ name: 'read_rules', arguments: { brandId: A.brandId } });
      expect(r.isError).toBeFalsy();
    } finally {
      await client.close();
    }
    expect(stderr).toContain('api key accepted');
    expect(stderr).not.toContain(A.writeKey.token);
  });

  it('exits 1 with a rejected key, without printing the key', async () => {
    const forged = `fbk_${'b'.repeat(16)}_${'Z'.repeat(43)}`;
    const r = await run(forged);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('FeedBouncer API key rejected');
    expect(r.stderr).not.toContain(forged);
    expect(r.stderr).not.toContain('Z'.repeat(43));
  });

  it('exits 1 with a malformed key, without printing it', async () => {
    const r = await run('not-a-key-secret-value-1234');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('FEEDBOUNCER_API_KEY is missing or malformed');
    expect(r.stderr).not.toContain('secret-value-1234');
  });
});
