import {
  renderAccountExists,
  renderInvitation,
  renderPasswordReset,
  renderVerifyEmail,
  type Mailer,
  type OutboundEmail,
} from '@feedbouncer/mailer';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';

export interface AuthEmails {
  verify(to: string, url: string): void;
  passwordReset(to: string, url: string): void;
  accountExists(to: string): void;
  invitation(
    to: string,
    p: { organizationName: string; inviterName: string | null; role: string; token: string },
  ): void;
}

export function createAuthEmails(mailer: Mailer, log: Logger, webOrigin: string): AuthEmails {
  // Fire-and-forget: response timing must not depend on whether an email is
  // sent, and an SMTP outage must not fail auth flows. Never log the message,
  // its recipient or its URL (the URL carries a token).
  const fire = (kind: string, msg: OutboundEmail) => {
    void mailer
      .send(msg)
      .catch((err: unknown) => log.warn('email send failed', { kind, ...errorFields(err) }));
  };
  return {
    verify: (to, url) => fire('verify', { to, ...renderVerifyEmail(url) }),
    passwordReset: (to, url) => fire('password_reset', { to, ...renderPasswordReset(url) }),
    accountExists: (to) =>
      fire('account_exists', {
        to,
        ...renderAccountExists(`${webOrigin}/login`, `${webOrigin}/forgot-password`),
      }),
    invitation: (to, p) =>
      fire('invitation', {
        to,
        ...renderInvitation({
          organizationName: p.organizationName,
          inviterName: p.inviterName,
          role: p.role,
          url: `${webOrigin}/invite?token=${encodeURIComponent(p.token)}`,
        }),
      }),
  };
}
