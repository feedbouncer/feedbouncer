import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { logConfigurationLoaded } from './startup.js';

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
