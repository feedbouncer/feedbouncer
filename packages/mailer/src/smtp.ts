import nodemailer from 'nodemailer';
import { headerSafe } from './templates.js';
import type { Mailer, OutboundEmail } from './mailer.js';

// One bare address: no list separators, display names or quoting that nodemailer would parse.
export const RECIPIENT = /^[^\s@,;<>"]+@[^\s@,;<>"]+$/;

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_MAX = 998;

function safeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw new Error('invalid header');
    out[name] = headerSafe(value, HEADER_MAX);
  }
  return out;
}

export function createSmtpMailer(smtpUrl: URL, from: string): Mailer & { close(): void } {
  const transport = nodemailer.createTransport(smtpUrl.href);
  return {
    async send(msg: OutboundEmail): Promise<void> {
      // Validate before anything reaches nodemailer. The address is left out of
      // the message so it does not end up in logs.
      if (!RECIPIENT.test(msg.to)) throw new Error('invalid recipient');
      const headers = msg.headers && safeHeaders(msg.headers);
      try {
        await transport.sendMail({
          from,
          to: msg.to,
          subject: headerSafe(msg.subject),
          text: msg.text,
          html: msg.html,
          ...(headers && { headers }),
          ...(msg.messageId !== undefined && { messageId: headerSafe(msg.messageId, HEADER_MAX) }),
        });
      } catch (cause) {
        throw new Error('smtp send failed', { cause });
      }
    },
    close(): void {
      transport.close();
    },
  };
}
