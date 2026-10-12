import {
  EnvError,
  readEnum,
  readInt,
  readString,
  readUrl,
  type Env,
} from '@feedbouncer/service-runtime';

export interface TelemetryConfig {
  readonly traces: { readonly exporter: 'none' | 'otlp'; readonly serviceName: string };
  readonly metrics: {
    readonly host: string;
    readonly port: number;
    readonly maxConnections: number;
  };
  readonly shutdownTimeoutMs: number;
}

const HTTP = ['http:', 'https:'] as const;

export function loadTelemetryConfig(env: Env, service: 'api' | 'worker'): TelemetryConfig {
  const disabled =
    readEnum(env, 'OTEL_SDK_DISABLED', ['true', 'false'] as const, 'false') === 'true';
  const exporter = readEnum(env, 'OTEL_TRACES_EXPORTER', ['none', 'otlp'] as const, 'none');
  for (const name of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) {
    if (!env[name]?.trim()) continue;
    const url = readUrl(env, name, HTTP);
    if (url.username || url.password) {
      throw new EnvError(`${name} must not embed credentials; use OTEL_EXPORTER_OTLP_HEADERS`);
    }
  }
  return {
    traces: {
      exporter: disabled ? 'none' : exporter,
      serviceName: readString(env, 'OTEL_SERVICE_NAME', {
        fallback: `feedbouncer-${service}`,
        maxLength: 64,
        pattern: /^[a-z][a-z0-9-]{0,63}$/,
      }),
    },
    metrics: {
      host: readString(env, 'METRICS_HOST', {
        fallback: '127.0.0.1',
        maxLength: 64,
        pattern: /^[A-Za-z0-9.:-]{1,64}$/,
      }),
      port: readInt(env, 'METRICS_PORT', {
        min: 0,
        max: 65_535,
        fallback: service === 'api' ? 9464 : 9465,
      }),
      maxConnections: readInt(env, 'METRICS_MAX_CONNECTIONS', {
        min: 1,
        max: 100_000,
        fallback: 1000,
      }),
    },
    shutdownTimeoutMs: readInt(env, 'TELEMETRY_SHUTDOWN_TIMEOUT_MS', {
      min: 100,
      max: 30_000,
      fallback: 5000,
    }),
  };
}
