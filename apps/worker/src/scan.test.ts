import { describe, expect, it } from 'vitest';
import type { Logger } from '@feedbouncer/service-runtime';
import { warnIfScanConsumerMissing } from './scan.js';

function recorder() {
  const lines: Array<{ level: string; msg: string; fields: object | undefined }> = [];
  const push = (level: string) => (msg: string, fields?: object) =>
    void lines.push({ level, msg, fields });
  const log: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
  return { log, lines };
}

describe('warnIfScanConsumerMissing', () => {
  it('warns when the tool is enabled but the facebook connector is not configured', () => {
    const { log, lines } = recorder();
    warnIfScanConsumerMissing({ enabled: true, started: false, facebookConfigured: false }, log);
    expect(lines).toEqual([
      {
        level: 'warn',
        msg: 'scan.consumer_not_started',
        fields: { reason: 'facebook_not_configured' },
      },
    ]);
  });

  it('warns when facebook is configured but its connector is not registered', () => {
    const { log, lines } = recorder();
    warnIfScanConsumerMissing({ enabled: true, started: false, facebookConfigured: true }, log);
    expect(lines).toEqual([
      {
        level: 'warn',
        msg: 'scan.consumer_not_started',
        fields: { reason: 'facebook_connector_unavailable' },
      },
    ]);
  });

  it('stays quiet when the consumer started or the tool is disabled', () => {
    const { log, lines } = recorder();
    warnIfScanConsumerMissing({ enabled: true, started: true, facebookConfigured: true }, log);
    warnIfScanConsumerMissing({ enabled: false, started: false, facebookConfigured: false }, log);
    expect(lines).toEqual([]);
  });
});
