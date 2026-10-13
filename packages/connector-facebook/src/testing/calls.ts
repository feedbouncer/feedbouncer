import { createSafeHttp } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
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
