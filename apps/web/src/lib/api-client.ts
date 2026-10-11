export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Browser-side JSON call to the same-origin API proxy; cookies carry the session.
export async function apiFetch<T>(
  path: `/api/${string}`,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
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
    error?: { code: string; message: string };
  } | null;
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      data?.error?.code ?? 'internal_error',
      data?.error?.message ?? 'Something went wrong.',
    );
  }
  return data as T;
}
