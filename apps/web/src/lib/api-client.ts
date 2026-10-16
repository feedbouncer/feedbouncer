export interface HandledDetails {
  status: string;
  decidedAt: string | null;
  decidedByName: string | null;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The limit a refused value exceeded (e.g. reply length in code points), when the API names one. */
    readonly max?: number | undefined,
    /** Field-level problems of a refused rule: a path such as conditions.patterns.1 and a message. */
    readonly issues: { path: string; message: string }[] = [],
    /** Who already decided a suggestion, on suggestion_already_handled. */
    readonly handled?: HandledDetails | undefined,
    /** The platform permission a connection lacks, on missing_permission. */
    readonly permission?: string | undefined,
  ) {
    super(message);
  }
}

function handledOf(v: unknown): HandledDetails | undefined {
  const { status, decidedAt, decidedByName } = (v ?? {}) as Record<string, unknown>;
  const optional = (x: unknown): x is string | null => x === null || typeof x === 'string';
  return typeof status === 'string' && optional(decidedAt) && optional(decidedByName)
    ? { status, decidedAt, decidedByName }
    : undefined;
}

function issuesOf(v: unknown): { path: string; message: string }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((i: unknown) => {
    const { path, message } = (i ?? {}) as { path?: unknown; message?: unknown };
    return typeof path === 'string' && typeof message === 'string' ? [{ path, message }] : [];
  });
}

// Browser-side JSON call to the same-origin API proxy; cookies carry the session.
export async function apiFetch<T>(
  path: `/api/${string}`,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? (method === 'GET' ? null : '{}') : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as {
    error?: {
      code: string;
      message: string;
      max?: unknown;
      issues?: unknown;
      handled?: unknown;
      permission?: unknown;
    };
  } | null;
  if (!res.ok) {
    const max = data?.error?.max;
    throw new ApiRequestError(
      res.status,
      data?.error?.code ?? 'internal_error',
      data?.error?.message ?? 'Something went wrong.',
      typeof max === 'number' && Number.isSafeInteger(max) ? max : undefined,
      issuesOf(data?.error?.issues),
      handledOf(data?.error?.handled),
      typeof data?.error?.permission === 'string' ? data.error.permission : undefined,
    );
  }
  return data as T;
}
