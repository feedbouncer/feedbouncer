import type { ReactNode } from 'react';

type Row = Record<string, string | number | boolean | string[]>;

const TABLES = {
  conditions: { caption: 'Rule conditions', columns: { type: 'Type', summary: 'Matches' } },
  steps: {
    caption: 'Action steps, in execution order',
    columns: { type: 'Step', reversible: 'Reversible', undo: 'Undo' },
  },
  conflicts: {
    caption: 'Step combinations that conflict',
    columns: { first: 'Step', second: 'Step', reason: 'Why' },
  },
  errors: {
    caption: 'Error codes',
    columns: { code: 'Code', status: 'Status', meaning: 'Meaning' },
  },
  'mcp-env': {
    caption: 'MCP server environment variables',
    columns: { name: 'Variable', required: 'Required', description: 'Description' },
  },
} as const;

export default function ReferenceTable({
  kind,
  data,
}: {
  kind: keyof typeof TABLES;
  data: readonly Row[];
}): ReactNode {
  const { caption, columns } = TABLES[kind];
  const keys = Object.keys(columns) as (keyof typeof columns)[];
  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {keys.map((k) => (
            <th key={k} scope="col">
              {columns[k]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i}>
            {keys.map((k) => (
              <td key={k}>{String(row[k] ?? '')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
