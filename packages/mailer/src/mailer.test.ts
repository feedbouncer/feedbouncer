import { describe, expect, it } from 'vitest';
import { MemoryMailer } from './mailer.js';
import { createSmtpMailer } from './smtp.js';

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

describe('createSmtpMailer', () => {
  it('rejects a recipient containing CR/LF before touching the network', async () => {
    const m = createSmtpMailer(new URL('smtp://127.0.0.1:1'), 'FeedBouncer <no-reply@x.test>');
    await expect(m.send(msg('a@x.test\r\nBcc: b@x.test'))).rejects.toThrow(/recipient/);
    m.close();
  });
  it.each([
    ['comma list', 'a@x.test,b@y.test'],
    ['comma after a bare local part', 'a@x.test,b'],
    ['semicolon list', 'a@x.test;b@y.test'],
    ['display name with angle brackets', 'Name<a@x.test>'],
    ['quoted', '"a"@x.test'],
  ])('rejects %s before touching the network', async (_label, to) => {
    const m = createSmtpMailer(new URL('smtp://127.0.0.1:1'), 'no-reply@x.test');
    await expect(m.send(msg(to))).rejects.toThrow(/^invalid recipient$/);
    m.close();
  });
  it('does not echo the address in the error', async () => {
    const m = createSmtpMailer(new URL('smtp://127.0.0.1:1'), 'no-reply@x.test');
    await expect(m.send(msg('not an address'))).rejects.toThrow(/^invalid recipient$/);
    m.close();
  });
});
