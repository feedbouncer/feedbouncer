import { McpServer } from '@modelcontextprotocol/server';
import { createLogger, type Logger } from '@feedbouncer/service-runtime';
import { version, type ApiPort } from './api-client.js';
import { UNTRUSTED_NOTICE } from './present.js';
import type { ToolDeps } from './tools/common.js';
import { registerListInbox } from './tools/list-inbox.js';
import { registerProposeRuleChange } from './tools/propose-rule-change.js';
import { registerReadRules } from './tools/read-rules.js';
import { registerReply } from './tools/reply.js';
import { registerSearchInbox } from './tools/search-inbox.js';
import { registerSummarize } from './tools/summarize.js';
import { registerVisibility } from './tools/visibility.js';

export interface ServerOptions {
  pollIntervalMs?: number;
  replyWaitMs?: number;
  log?: Logger;
}

const INSTRUCTIONS = [
  'FeedBouncer moderates comments on brand Facebook and Instagram accounts.',
  'These tools read the comment inbox, reply to comments, hide or unhide them, summarize activity and read moderation rules.',
  UNTRUSTED_NOTICE,
  'propose_rule_change only creates a pending proposal; a person must approve it in the FeedBouncer web app. No tool can approve.',
].join(' ');

export const stderrLogger = (): Logger =>
  createLogger('mcp', 'info', (line) => {
    process.stderr.write(`${line}\n`);
  });

export function buildServer(api: ApiPort, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'feedbouncer', version }, { instructions: INSTRUCTIONS });
  const deps: ToolDeps = {
    api,
    log: opts.log ?? stderrLogger(),
    pollIntervalMs: opts.pollIntervalMs ?? 500,
    replyWaitMs: opts.replyWaitMs ?? 15_000,
  };
  for (const register of [
    registerListInbox,
    registerSearchInbox,
    registerReply,
    registerVisibility,
    registerSummarize,
    registerReadRules,
    registerProposeRuleChange,
  ]) {
    register(server, deps);
  }
  return server;
}
