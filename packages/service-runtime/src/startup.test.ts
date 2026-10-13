import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { EnvError } from './env.js';
import { logConfigurationLoaded, writeStartupConfigError } from './startup.js';

describe('logConfigurationLoaded', () => {
  it('logs the app environment and the active key id readably', () => {
    const lines: string[] = [];
    logConfigurationLoaded(
      createLogger('api', 'info', (l) => lines.push(l)),
      { appEnv: 'production', encryption: { activeKeyId: 'k2026b' } },
    );
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      msg: 'configuration loaded',
      appEnv: 'production',
      activeKeyId: 'k2026b',
    });
  });
});

it('writes configuration errors as one JSON line without secrets', () => {
  const lines: string[] = [];
  writeStartupConfigError('api', new EnvError('DATABASE_URL invalid: postgres://u:pw@h/db'), (l) =>
    lines.push(l),
  );
  const o = JSON.parse(lines[0]!);
  expect(o).toMatchObject({ level: 'error', service: 'api', msg: 'invalid configuration' });
  expect(lines[0]).not.toContain('pw@');
  writeStartupConfigError('worker', new Error('internal detail'), (l) => lines.push(l));
  expect(JSON.parse(lines[1]!).error).toBe('Invalid configuration');
});
