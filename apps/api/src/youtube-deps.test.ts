import { Secret } from '@feedbouncer/service-runtime';
import { describe, expect, it, vi } from 'vitest';
import type { QuotaMeter } from '@feedbouncer/connectors';
import { buildYouTubeDeps } from './youtube-deps.js';

const youtube = {
  clientId: '123-abc.apps.googleusercontent.com',
  clientSecret: new Secret('youtube-secret-0123456789'),
  projectDailyQuota: 10_000,
  projectHeadroomUnits: 1000,
  schedulerTickSec: 60,
  backlogCap: 5000,
};
const meter = { reserve: vi.fn(), settle: vi.fn() } as QuotaMeter;

describe('buildYouTubeDeps', () => {
  it('is null when the connector is not enabled', () => {
    expect(buildYouTubeDeps({ youtube: null }, meter)).toBeNull();
  });

  it('registers the connector, which needs no webhook app secret', () => {
    const d = buildYouTubeDeps({ youtube }, meter)!;
    expect(d.connectors.map((c) => c.platform)).toEqual(['youtube']);
    expect(d.appSecrets).toEqual({});
  });
});
