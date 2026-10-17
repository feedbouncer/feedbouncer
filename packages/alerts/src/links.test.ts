import { describe, expect, it } from 'vitest';
import {
  confirmLink,
  reviewLink,
  settingsLink,
  spikeLink,
  unsubscribeApiUrl,
  unsubscribeLink,
} from './links.js';

const web = new URL('https://app.example.test/ignored/path?x=1');
const ORG = '11111111-1111-4111-8111-111111111111';
const BRAND = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_';
const from = new Date('2026-10-17T09:00:00.000Z');
const to = new Date('2026-10-17T10:00:00.000Z');

describe('links', () => {
  it('builds the exact URLs on the web origin', () => {
    expect(spikeLink(web, ORG, BRAND, from, to)).toBe(
      `https://app.example.test/orgs/${ORG}/comments?brand=${BRAND}&signal=negative` +
        '&from=2026-10-17T09:00:00.000Z&to=2026-10-17T10:00:00.000Z&queue=all',
    );
    expect(reviewLink(web, ORG, BRAND)).toBe(
      `https://app.example.test/orgs/${ORG}/brands/${BRAND}/review`,
    );
    expect(settingsLink(web, ORG)).toBe(`https://app.example.test/orgs/${ORG}/alerts`);
    expect(settingsLink(web, ORG, BRAND)).toBe(
      `https://app.example.test/orgs/${ORG}/brands/${BRAND}/alerts`,
    );
    expect(confirmLink(web, TOKEN)).toBe(`https://app.example.test/alerts/confirm?token=${TOKEN}`);
    expect(unsubscribeLink(web, TOKEN)).toBe(
      `https://app.example.test/alerts/unsubscribe?token=${TOKEN}`,
    );
    expect(unsubscribeApiUrl(web, TOKEN)).toBe(
      `https://app.example.test/api/v1/alert-recipients/unsubscribe?token=${TOKEN}`,
    );
  });

  it('throws TypeError on non-uuid ids, bad dates and bad tokens', () => {
    const bad = ['../evil', `${ORG}/x`, '', ORG.toUpperCase() + 'x', 'javascript:alert(1)'];
    for (const id of bad) {
      expect(() => spikeLink(web, id, BRAND, from, to)).toThrow(TypeError);
      expect(() => spikeLink(web, ORG, id, from, to)).toThrow(TypeError);
      expect(() => reviewLink(web, id, BRAND)).toThrow(TypeError);
      expect(() => reviewLink(web, ORG, id)).toThrow(TypeError);
      expect(() => settingsLink(web, id)).toThrow(TypeError);
      expect(() => settingsLink(web, ORG, id)).toThrow(TypeError);
    }
    expect(() => spikeLink(web, ORG, BRAND, new Date('nope'), to)).toThrow(TypeError);
    for (const t of ['', 'a b', 'x&y=1', 'tok/../../']) {
      expect(() => confirmLink(web, t)).toThrow(TypeError);
      expect(() => unsubscribeLink(web, t)).toThrow(TypeError);
      expect(() => unsubscribeApiUrl(web, t)).toThrow(TypeError);
    }
  });
});
