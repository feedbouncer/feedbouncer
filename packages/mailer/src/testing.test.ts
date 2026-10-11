import { describe, expect, it } from 'vitest';
import { extractFirstUrl, MemoryMailer } from './testing.js';

const msg = (to: string) => ({ to, subject: 's', text: 't', html: '<p>t</p>' });

describe('MemoryMailer', () => {
  it('records messages and clears them', async () => {
    const m = new MemoryMailer();
    await m.send(msg('a@x.test'));
    expect(m.sent).toHaveLength(1);
    m.clear();
    expect(m.sent).toHaveLength(0);
  });
  it('lastTo matches case-insensitively and returns the latest', async () => {
    const m = new MemoryMailer();
    await m.send({ ...msg('Alice@X.test'), subject: 'first' });
    await m.send({ ...msg('alice@x.test'), subject: 'second' });
    expect(m.lastTo('ALICE@x.TEST')?.subject).toBe('second');
    expect(m.lastTo('bob@x.test')).toBeUndefined();
  });
});

describe('extractFirstUrl', () => {
  it('finds the link in a text body', () => {
    expect(extractFirstUrl('Click: http://localhost:3000/invite?token=a_b-c\nThanks')).toBe(
      'http://localhost:3000/invite?token=a_b-c',
    );
  });
});
