import type { ReactNode } from 'react';
import manifest from '../../docs/_generated/tools.json';

interface Schema {
  type?: string | string[];
  format?: string;
  enum?: readonly unknown[];
  items?: Schema;
  anyOf?: readonly Schema[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

// The manifest is JSON, so TypeScript infers each tool's schema from its own literal; this is the common shape.
const tools = manifest.tools as unknown as readonly {
  name: string;
  inputSchema: Schema;
  outputSchema: Schema;
}[];

function typeOf(s: Schema): string {
  if (s.enum) return s.enum.map((v) => String(v)).join(' | ');
  if (s.anyOf) return s.anyOf.map(typeOf).join(' | ');
  const base = Array.isArray(s.type) ? s.type.join(' | ') : (s.type ?? 'any');
  if (base === 'array' && s.items) return `array of ${typeOf(s.items)}`;
  return s.format ? `${base} (${s.format})` : base;
}

function range(min: number | undefined, max: number | undefined, unit: string): string {
  if (min !== undefined && max !== undefined) return `${min} to ${max}${unit}`;
  if (max !== undefined) return `at most ${max}${unit}`;
  return min === undefined ? '' : `at least ${min}${unit}`;
}

function limitsOf(s: Schema): string {
  return [
    range(s.minimum, s.maximum, ''),
    range(s.minLength, s.maxLength, ' characters'),
    s.default === undefined ? '' : `default ${JSON.stringify(s.default)}`,
  ]
    .filter(Boolean)
    .join(', ');
}

function Table({ caption, schema, input }: { caption: string; schema: Schema; input: boolean }) {
  const rows = Object.entries(schema.properties ?? {});
  if (rows.length === 0) return <p>{caption}: none.</p>;
  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Type</th>
          {input && <th scope="col">Required</th>}
          <th scope="col">Limits</th>
          <th scope="col">Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, s]) => (
          <tr key={name}>
            <td>
              <code>{name}</code>
            </td>
            <td>{typeOf(s)}</td>
            {input && <td>{schema.required?.includes(name) ? 'yes' : 'no'}</td>}
            <td>{limitsOf(s)}</td>
            <td>{s.description ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The input and output of one MCP tool, as tables built from the committed tool manifest. */
export default function McpToolReference({ name }: { name: string }): ReactNode {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
  return (
    <>
      <Table caption={`${name} input`} schema={tool.inputSchema} input />
      <Table caption={`${name} structured output`} schema={tool.outputSchema} input={false} />
    </>
  );
}
