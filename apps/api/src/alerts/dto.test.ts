import { describe, expect, it } from 'vitest';
import {
  BrandAlertsBody,
  EmailCreateBody,
  SlackCreateBody,
  TokenBody,
  toChannelDto,
  toEventDto,
} from './dto.js';

const ID = '00000000-0000-4000-8000-000000000001';
const settings = {
  sensitivity: 'medium',
  minNegativeCount: 10,
  cooldownMinutes: 360,
  contentMode: 'excerpts',
};

describe('alerts dto', () => {
  it('slack and email bodies are strict and bounded', () => {
    expect(SlackCreateBody.safeParse({ label: ' x ', webhookUrl: 'u' }).data?.label).toBe('x');
    expect(SlackCreateBody.safeParse({ label: '', webhookUrl: 'u' }).success).toBe(false);
    expect(SlackCreateBody.safeParse({ label: 'x', webhookUrl: 'u'.repeat(301) }).success).toBe(
      false,
    );
    expect(SlackCreateBody.safeParse({ label: 'x', webhookUrl: 'u', extra: 1 }).success).toBe(
      false,
    );
    expect(EmailCreateBody.safeParse({ email: 'a'.repeat(321) }).success).toBe(false);
    expect(EmailCreateBody.safeParse({ email: 'a@b.test', label: 'l'.repeat(81) }).success).toBe(
      false,
    );
  });

  it('tokens are exactly 43 base64url characters', () => {
    expect(TokenBody.safeParse({ token: 'a'.repeat(43) }).success).toBe(true);
    expect(TokenBody.safeParse({ token: 'a'.repeat(42) }).success).toBe(false);
    expect(TokenBody.safeParse({ token: `${'a'.repeat(42)}=` }).success).toBe(false);
  });

  it('brand settings: ranges, enums, duplicate routes and route cap', () => {
    const route = { alertType: 'negative_spike', channelId: ID, enabled: true };
    expect(BrandAlertsBody.safeParse({ settings, routes: [route] }).success).toBe(true);
    for (const bad of [
      { ...settings, minNegativeCount: 2 },
      { ...settings, minNegativeCount: 1001 },
      { ...settings, cooldownMinutes: 29 },
      { ...settings, cooldownMinutes: 1441 },
      { ...settings, sensitivity: 'extreme' },
      { ...settings, contentMode: 'all' },
    ]) {
      expect(BrandAlertsBody.safeParse({ settings: bad, routes: [] }).success).toBe(false);
    }
    expect(BrandAlertsBody.safeParse({ settings, routes: [route, route] }).success).toBe(false);
    expect(
      BrandAlertsBody.safeParse({
        settings,
        routes: [route, { ...route, alertType: 'flagged_item' }],
      }).success,
    ).toBe(true);
    expect(
      BrandAlertsBody.safeParse({ settings, routes: [{ ...route, channelId: 'nope' }] }).success,
    ).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({
      ...route,
      channelId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    expect(BrandAlertsBody.safeParse({ settings, routes: many }).success).toBe(false);
  });

  it('channel and event dtos serialize dates and carry no secrets', () => {
    const at = new Date('2026-10-17T10:00:00.000Z');
    const c = toChannelDto({
      id: ID,
      kind: 'slack',
      label: 'ops',
      status: 'active',
      health: 'active',
      hint: 'T…ABCD/B…WXYZ',
      email: null,
      lastFailureCode: null,
      lastFailureAt: at,
      disconnectedCode: null,
      createdAt: at,
    });
    expect(c.createdAt).toBe(at.toISOString());
    expect(c.lastFailureAt).toBe(at.toISOString());
    const e = toEventDto({
      id: ID,
      alert_type: 'negative_spike',
      status: 'queued',
      created_at: at,
      window_start: at,
      window_end: at,
      payload: {
        kind: 'spike',
        negatives: 12,
        total: 40,
        expectedPerHour: 2,
        trigger: 'volume',
        sensitivity: 'medium',
        minCount: 10,
        commentIds: ['x'],
      },
      deliveries: [],
    });
    expect(e.counts).toEqual({ negatives: 12, total: 40 });
    expect(e.explanation).toEqual({
      trigger: 'volume',
      expectedPerHour: 2,
      sensitivity: 'medium',
      minCount: 10,
    });
    expect(JSON.stringify(e)).not.toContain('commentIds');
    expect(
      toEventDto({
        ...{
          id: ID,
          alert_type: 'flagged_digest',
          status: 'queued',
          created_at: at,
          window_start: null,
          window_end: null,
          deliveries: [],
        },
        payload: { kind: 'flags', count: 3 },
      }).explanation,
    ).toBeNull();
  });
});
