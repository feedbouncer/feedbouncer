#!/usr/bin/env node
// stdout carries only MCP protocol frames; every diagnostic goes to stderr.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { errorFields, installCrashHandlers, redact } from '@feedbouncer/service-runtime';
import { ApiCallError, FeedBouncerApi } from './api-client.js';
import { ConfigError, loadConfig } from './config.js';
import { buildServer, stderrLogger } from './server.js';

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

export async function main(): Promise<void> {
  const log = stderrLogger();
  installCrashHandlers(log);
  const cfg = loadConfig(process.env);
  const api = new FeedBouncerApi(cfg);
  try {
    const key = await api.whoami();
    log.info('api key accepted', { organizationId: key.organizationId, scope: key.scope });
  } catch (e) {
    if (e instanceof ApiCallError && e.code === 'unauthenticated') {
      return fail('FeedBouncer API key rejected');
    }
    // The API may come up later; tools report it as unreachable until then.
    log.warn('could not verify the API key at startup', errorFields(e));
  }
  serveStdio(() => buildServer(api, { replyWaitMs: cfg.replyWaitMs, log }), {
    onerror: (e) => log.error('transport error', errorFields(e)),
  });
}

main().catch((e: unknown) => {
  fail(e instanceof ConfigError ? e.message : redact(e instanceof Error ? e.message : String(e)));
});
