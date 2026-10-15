import { createSafeHttp, type CallContext } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import type { FacebookConfig } from '../config.js';
import { GRAPH_HOST, type GraphCall } from '../graph.js';
import type { FakeGraph } from './fake-graph.js';

/** A `GraphCall` over the fake, authenticated with `token` (a Page or user token the fake issued). */
export function pageCall(graph: FakeGraph, token: string): GraphCall {
  return {
    http: createSafeHttp({ allowedHosts: [GRAPH_HOST], fetch: graph.fetch }),
    signal: new AbortController().signal,
    version: 'v26.0',
    appSecret: new Secret(graph.appSecretValue()),
    token: new Secret(token),
    nowMs: Date.now,
  };
}

/** Config matching the fake's app id, secret and version. */
export function testConfig(graph: FakeGraph): FacebookConfig {
  return {
    appId: '1',
    appSecret: new Secret(graph.appSecretValue()),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  };
}

/** A `CallContext` over the fake for one connected account. */
export function ctxFor(graph: FakeGraph, token: string, externalAccountId: string): CallContext {
  return {
    accessToken: new Secret(token),
    externalAccountId,
    http: createSafeHttp({ allowedHosts: [GRAPH_HOST], fetch: graph.fetch }),
    signal: new AbortController().signal,
    reportQuota: async () => undefined,
  };
}
