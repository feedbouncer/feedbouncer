import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { createLogger } from '@feedbouncer/service-runtime';
import { buildServer, type ServerOptions } from '../server.js';
import { FakeApi } from './fake-api.js';

export interface Harness {
  api: FakeApi;
  client: Client;
  logs: string[];
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Connects a Client to buildServer(FakeApi) over an in-memory linked pair. */
export async function connect(opts: ServerOptions = {}, api = new FakeApi()): Promise<Harness> {
  const logs: string[] = [];
  const server = buildServer(api, {
    pollIntervalMs: 5,
    replyWaitMs: 500,
    log: createLogger('mcp', 'debug', (line) => logs.push(line)),
    ...opts,
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return {
    api,
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

export const textOf = (r: CallToolResult): string =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
