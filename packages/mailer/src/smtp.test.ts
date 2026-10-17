import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSmtpMailer } from './smtp.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const capture = () => {
  const sendMail = vi.fn().mockResolvedValue({});
  vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
    sendMail,
    close: () => {},
  } as unknown as ReturnType<typeof nodemailer.createTransport>);
  return sendMail;
};

describe('createSmtpMailer headers', () => {
  it('headers and messageId are forwarded; CRLF in a header value is stripped', async () => {
    const sendMail = capture();
    const m = createSmtpMailer(new URL('smtp://127.0.0.1:1'), 'no-reply@x.test');
    const long = `<https://app.test/api/v1/alert-recipients/unsubscribe?token=${'a'.repeat(43)}>, <https://app.test/alerts/unsubscribe?token=${'a'.repeat(43)}>`;
    await m.send({
      to: 'a@x.test',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      headers: {
        'List-Unsubscribe': long,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click\r\nBcc: victim@x.test',
      },
      messageId: '<alert-1@app.test>\r\nBcc: victim@x.test',
    });
    const opts = sendMail.mock.calls[0]![0];
    expect(opts.headers).toEqual({
      'List-Unsubscribe': long,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click Bcc: victim@x.test',
    });
    expect(opts.messageId).toBe('<alert-1@app.test> Bcc: victim@x.test');
    m.close();
  });

  it('omits headers and messageId when not given', async () => {
    const sendMail = capture();
    const m = createSmtpMailer(new URL('smtp://127.0.0.1:1'), 'no-reply@x.test');
    await m.send({ to: 'a@x.test', subject: 's', text: 't', html: '<p>t</p>' });
    const opts = sendMail.mock.calls[0]![0];
    expect(opts).not.toHaveProperty('headers');
    expect(opts).not.toHaveProperty('messageId');
    m.close();
  });

  it('rejects a header name that is not a plain token', async () => {
    const sendMail = capture();
    const m = createSmtpMailer(new URL('smtp://127.0.0.1:1'), 'no-reply@x.test');
    await expect(
      m.send({
        to: 'a@x.test',
        subject: 's',
        text: 't',
        html: '',
        headers: { 'X-A\r\nBcc': 'v' },
      }),
    ).rejects.toThrow(/^invalid header$/);
    expect(sendMail).not.toHaveBeenCalled();
    m.close();
  });
});
