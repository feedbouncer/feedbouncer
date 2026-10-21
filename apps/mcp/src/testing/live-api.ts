// A real FeedBouncer API (scratch database, real Redis, FakeGraph behind the Facebook
// connector) listening on a loopback port, for tests that drive the MCP server end to end.
// Needs DATABASE_URL and REDIS_URL, like the API integration tests.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import {
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
} from '@feedbouncer/api/testing';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { PgApiKeys } from '@feedbouncer/public-api';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { FeedBouncerApi } from '../api-client.js';
import { loadConfig } from '../config.js';
import { buildServer } from '../server.js';

const SECRET = 'fb-app-secret-0123456789abcdef';
const APP_ID = '1112223334';
const FACEBOOK = {
  appId: APP_ID,
  appSecret: new Secret(SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

export interface Page {
  pageId: string;
  scope: { organizationId: string; brandId: string; connectionId: string };
}

export interface Tenant extends OrgFixture {
  page: Page;
  writeKey: { id: string; token: string };
}

export interface LiveApi {
  api: TestApi;
  graph: FakeGraph;
  /** Base URL of the listening API, e.g. http://127.0.0.1:54321. */
  url: string;
  tenant(label: string): Promise<Tenant>;
  newKey(org: OrgFixture, scope: 'read' | 'write'): Promise<{ id: string; token: string }>;
  comment(page: Page, body: string): Promise<{ id: string; externalId: string }>;
  close(): Promise<void>;
}

export async function startLiveApi(): Promise<LiveApi> {
  const graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  const api = await startTestApi(
    { facebook: FACEBOOK, publicApiRateLimitPerMinute: 10_000 },
    { fetch: graph.fetch },
  );
  await api.app.listen(0, '127.0.0.1');
  const { port } = api.app.getHttpServer().address() as AddressInfo;
  const keys = new PgApiKeys(api.pool);

  const newKey: LiveApi['newKey'] = async (org, scope) => {
    const { key, token } = await keys.create(org.orgId, org.owner.userId, {
      name: `k-${randomUUID()}`,
      scope,
    });
    return { id: key.id, token: token.reveal() };
  };

  async function connectedPage(org: OrgFixture): Promise<Page> {
    const { pageId, pageToken } = graph.addPage(graph.addUser('Owner').userId, { name: 'Shop' });
    const { rows } = await api.pool.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, 'facebook', $3, 'active') RETURNING id`,
      [org.orgId, org.brandId, pageId],
    );
    const scope = { organizationId: org.orgId, brandId: org.brandId, connectionId: rows[0]!.id };
    await api.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(pageToken), null);
    return { pageId, scope };
  }

  return {
    api,
    graph,
    url: `http://127.0.0.1:${port}`,
    newKey,
    async tenant(label) {
      const org = await orgWithRoles(api, label);
      return { ...org, page: await connectedPage(org), writeKey: await newKey(org, 'write') };
    },
    // Stored the way the ingest job stores comments.
    async comment(page, body) {
      const c = graph.addComment(page.pageId, { message: body, createdAtMs: Date.now() });
      const authorId = String(3_000_000_000 + Math.floor(Math.random() * 1_000_000));
      const r = await api.deps.comments!.store.upsertFromPlatform(
        page.scope,
        {
          externalId: c.commentId,
          sourceExternalId: c.postId,
          parentExternalId: null,
          author: { externalId: authorId, displayName: `Author ${authorId}`, profileUrl: null },
          body,
          postedAt: new Date(),
          platformState: 'visible',
          permalink: null,
        },
        { ownAccountExternalId: page.pageId, syncedAt: new Date() },
      );
      if (r.suppressed) throw new Error('comment_suppressed');
      return { id: r.commentId, externalId: c.commentId };
    },
    close: () => api.close(),
  };
}

export interface McpSession {
  client: Client;
  logs: string[];
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** buildServer over a real FeedBouncerApi client, connected to an in-memory MCP client. */
export async function mcpSession(
  url: string,
  token: string,
  opts: { replyWaitMs?: number } = {},
): Promise<McpSession> {
  const cfg = loadConfig({ FEEDBOUNCER_API_URL: url, FEEDBOUNCER_API_KEY: token });
  const logs: string[] = [];
  const server = buildServer(new FeedBouncerApi(cfg), {
    pollIntervalMs: 50,
    replyWaitMs: opts.replyWaitMs ?? 10_000,
    log: createLogger('mcp', 'debug', (line) => logs.push(line)),
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return {
    client,
    logs,
    call: async (name, args = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export { textOf } from './harness.js';
