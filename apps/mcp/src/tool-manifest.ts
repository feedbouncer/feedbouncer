import { MCP_ENV_DOCS } from './config.js';
import { connect } from './testing/harness.js';

export interface ToolManifest {
  server: { name: 'feedbouncer'; transport: 'stdio' };
  env: typeof MCP_ENV_DOCS;
  tools: {
    name: string;
    title?: string;
    description: string;
    inputSchema: object;
    outputSchema: object;
    annotations?: object;
  }[];
}

/** The tools/list answer of the real server, for docs/mcp/tools.json. */
export async function buildToolManifest(): Promise<ToolManifest> {
  const h = await connect();
  try {
    const { tools } = await h.client.listTools();
    return {
      server: { name: 'feedbouncer', transport: 'stdio' },
      env: MCP_ENV_DOCS,
      tools: tools
        .map((t) => ({
          name: t.name,
          ...(t.title !== undefined && { title: t.title }),
          description: t.description ?? '',
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema ?? {},
          ...(t.annotations !== undefined && { annotations: t.annotations }),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  } finally {
    await h.close();
  }
}
