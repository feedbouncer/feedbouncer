export type HealthCheck = () => Promise<unknown>;
export type CheckStatus = 'up' | 'down';
export interface HealthReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: Readonly<Record<string, CheckStatus>>;
}
export interface RunChecksOptions {
  readonly timeoutMs: number;
  readonly onFailure?: (name: string, err: unknown) => void;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The report deliberately carries no error text: /healthz is reachable from
// the host, and driver errors can include hostnames or user names.
export async function runChecks(
  checks: Readonly<Record<string, HealthCheck>>,
  opts: RunChecksOptions,
): Promise<HealthReport> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, CheckStatus]> => {
      try {
        await withTimeout(Promise.resolve().then(check), opts.timeoutMs, name);
        return [name, 'up'];
      } catch (err) {
        opts.onFailure?.(name, err);
        return [name, 'down'];
      }
    }),
  );
  return {
    status: entries.every(([, s]) => s === 'up') ? 'ok' : 'unavailable',
    checks: Object.fromEntries(entries),
  };
}
