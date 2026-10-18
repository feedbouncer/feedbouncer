import type { OutboundEmail } from './mailer.js';

type Body = Omit<OutboundEmail, 'to'>;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

// Control characters (CR/LF included) become spaces so a value can never add a header.
export const headerSafe = (s: string, max = 150): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);

function page(title: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  const ps = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const link = cta ? `<p><a href="${escapeHtml(cta.url)}">${escapeHtml(cta.label)}</a></p>` : '';
  return `<!doctype html><html><body><h1>${escapeHtml(title)}</h1>${ps}${link}</body></html>`;
}

export function renderVerifyEmail(url: string): Body {
  const intro =
    'Confirm your email address to finish setting up your FeedBouncer account. The link expires in 24 hours.';
  return {
    subject: 'Confirm your email for FeedBouncer',
    text: `${intro}\n\n${url}\n`,
    html: page('Confirm your email', [intro], { label: 'Confirm email', url }),
  };
}

export function renderPasswordReset(url: string): Body {
  const intro =
    'Someone asked to reset your FeedBouncer password. The link works once and expires in 1 hour. If this was not you, ignore this email.';
  return {
    subject: 'Reset your FeedBouncer password',
    text: `${intro}\n\n${url}\n`,
    html: page('Reset your password', [intro], { label: 'Reset password', url }),
  };
}

export function renderAccountExists(loginUrl: string, resetUrl: string): Body {
  const intro =
    'Someone tried to create a FeedBouncer account with this email, but you already have one. Log in, or reset your password if you forgot it.';
  return {
    subject: 'You already have a FeedBouncer account',
    text: `${intro}\n\nLog in: ${loginUrl}\nReset password: ${resetUrl}\n`,
    html: page('You already have an account', [intro, `Forgot your password? ${resetUrl}`], {
      label: 'Log in',
      url: loginUrl,
    }),
  };
}

export function renderSignupClosed(p: { supportEmail: string | null }): Body {
  const intro =
    'Someone tried to create a FeedBouncer account with this email, but FeedBouncer is in private beta and sign-up is by invitation only. No account was created.';
  const contact = p.supportEmail
    ? `To ask for access, write to ${headerSafe(p.supportEmail)}.`
    : '';
  const paragraphs = contact ? [intro, contact] : [intro];
  return {
    subject: 'FeedBouncer is in private beta',
    text: `${paragraphs.join('\n\n')}\n`,
    html: page('FeedBouncer is in private beta', paragraphs),
  };
}

export function renderInvitation(p: {
  organizationName: string;
  inviterName: string | null;
  role: string;
  url: string;
}): Body {
  const org = headerSafe(p.organizationName);
  const inviter = p.inviterName ? headerSafe(p.inviterName) : '';
  const who = inviter ? `${inviter} invited you` : 'You have been invited';
  const intro = `${who} to join ${org} on FeedBouncer as ${p.role}. The invitation expires in 7 days.`;
  return {
    subject: `Join ${org} on FeedBouncer`,
    text: `${intro}\n\n${p.url}\n`,
    html: page(`Join ${org}`, [intro], { label: 'Accept invitation', url: p.url }),
  };
}

export function renderReconnectRequired(p: {
  brandName: string;
  accountName: string | null;
  platformLabel: string;
  settingsUrl: string;
}): Body {
  const brand = headerSafe(p.brandName);
  const account = p.accountName ? headerSafe(p.accountName) : '';
  const which = account ? `${p.platformLabel} "${account}"` : `a ${p.platformLabel}`;
  const intro = `FeedBouncer lost access to ${which} connected to ${brand}. Comments on it cannot be moderated until it is reconnected.`;
  return {
    subject: `Action needed: reconnect a ${headerSafe(p.platformLabel)} in FeedBouncer`,
    text: `${intro}\n\n${p.settingsUrl}\n`,
    html: page('Reconnect required', [intro], { label: 'Open connections', url: p.settingsUrl }),
  };
}
