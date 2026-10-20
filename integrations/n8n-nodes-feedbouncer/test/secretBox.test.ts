import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from '../nodes/FeedBouncerTrigger/secretBox';

const SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const KEY = 'fbk_live_one';

describe('secretBox', () => {
  it('round-trips with the same api key', () => {
    expect(openSecret(sealSecret(SECRET, KEY), KEY)).toBe(SECRET);
  });

  it('does not contain the secret in clear text', () => {
    const sealed = sealSecret(SECRET, KEY);
    expect(sealed).not.toContain(SECRET.slice('whsec_'.length));
    expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain(SECRET.slice('whsec_'.length, 20));
  });

  it('uses a fresh salt and nonce each time', () => {
    expect(sealSecret(SECRET, KEY)).not.toBe(sealSecret(SECRET, KEY));
  });

  it('opens to undefined with another api key', () => {
    expect(openSecret(sealSecret(SECRET, KEY), 'fbk_live_two')).toBeUndefined();
  });

  it('opens to undefined when the stored value was altered', () => {
    const bytes = Buffer.from(sealSecret(SECRET, KEY), 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(openSecret(bytes.toString('base64'), KEY)).toBeUndefined();
  });

  it.each([undefined, '', 'whsec_plain', 'AAAA', 42, null])('opens to undefined for %s', (value) => {
    expect(openSecret(value as string | undefined, KEY)).toBeUndefined();
  });
});
