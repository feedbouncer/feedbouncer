// Postgres text cannot hold NUL. Connector-supplied strings that are persisted
// without zod validation are cleaned at the adapter boundary, like bodies are
// cleaned by the output schema.
export const noNul = (s: string): string => s.replaceAll('\u0000', '�');
