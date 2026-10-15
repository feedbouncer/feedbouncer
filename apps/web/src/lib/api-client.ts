export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The limit a refused value exceeded (e.g. reply length in code points), when the API names one. */
    readonly max?: number | undefined,
    /** Field-level problems of a refused rule: a path such as conditions.patterns.1 and a message. */
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
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
    error?: { code: string; message: string; max?: unknown; issues?: unknown };
  } | null;
  if (!res.ok) {
    const max = data?.error?.max;
    throw new ApiRequestError(
      res.status,
      data?.error?.code ?? 'internal_error',
      data?.error?.message ?? 'Something went wrong.',
      typeof max === 'number' && Number.isSafeInteger(max) ? max : undefined,
      issuesOf(data?.error?.issues),
    );
  }
  return data as T;
}
