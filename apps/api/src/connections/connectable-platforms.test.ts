import { describe, expect, it } from 'vitest';
import type { Platform } from '@feedbouncer/connectors';
import type { AppDeps } from '../deps.js';
import { connectablePlatforms } from './connectable-platforms.js';

const depsWith = (caps: Partial<Record<Platform, 'single' | 'multiple' | undefined>>) =>
  ({
    connectors: {
      registry: {
        get: (p: Platform) =>
          p in caps ? { capabilities: { accountSelection: caps[p] } } : undefined,
      },
    },
  }) as unknown as AppDeps;

describe('connectablePlatforms', () => {
  it('with no connectors returns []', () => {
    expect(connectablePlatforms({ connectors: null } as unknown as AppDeps)).toEqual([]);
  });

  it('returns only registered multi-select platforms', () => {
    const deps = depsWith({
      instagram: 'multiple',
      facebook: 'multiple',
      youtube: 'single',
      x: undefined,
    });
    expect(connectablePlatforms(deps)).toEqual(['facebook', 'instagram']);
  });
});
