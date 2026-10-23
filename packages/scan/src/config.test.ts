import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import type { FacebookConfig } from '@feedbouncer/connector-facebook';
import { parseScanEnv } from './config.js';

const facebook = {} as FacebookConfig;
const ready = { facebook, classifierProvider: 'openai' };

describe('parseScanEnv', () => {
  it('defaults to disabled with the documented limits', () => {
    expect(parseScanEnv({}, { facebook: null, classifierProvider: 'none' })).toEqual({
      enabled: false,
      maxComments: 2000,
      retentionDays: 30,
      workerConcurrency: 2,
    });
  });

  it('reads the settings when enabled', () => {
    expect(
      parseScanEnv(
        {
          SCAN_TOOL_ENABLED: 'true',
          SCAN_MAX_COMMENTS: '100',
          SCAN_RETENTION_DAYS: '1',
          SCAN_WORKER_CONCURRENCY: '16',
        },
        ready,
      ),
    ).toEqual({ enabled: true, maxComments: 100, retentionDays: 1, workerConcurrency: 16 });
  });

  it('refuses to enable without the Facebook config or a classifier', () => {
    const on = { SCAN_TOOL_ENABLED: 'true' };
    expect(() => parseScanEnv(on, { facebook: null, classifierProvider: 'openai' })).toThrow(
      EnvError,
    );
    expect(() => parseScanEnv(on, { facebook, classifierProvider: 'none' })).toThrow(EnvError);
  });

  it.each([
    ['SCAN_TOOL_ENABLED', 'yes'],
    ['SCAN_RETENTION_DAYS', '31'],
    ['SCAN_RETENTION_DAYS', '0'],
    ['SCAN_MAX_COMMENTS', '99'],
    ['SCAN_MAX_COMMENTS', '5001'],
    ['SCAN_WORKER_CONCURRENCY', '17'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => parseScanEnv({ [name]: value }, ready)).toThrow(EnvError);
  });
});
