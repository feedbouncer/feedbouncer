import { describe, expect, it } from 'vitest';
import { createSmtpMailer } from './smtp.js';

const msg = (to: string) => ({ to, subject: 's', text: 't', html: '<p>t</p>' });

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
