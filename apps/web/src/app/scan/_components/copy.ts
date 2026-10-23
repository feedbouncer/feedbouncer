import type { ScanCategory, ScanFailure, ScanNotice, ScanTag } from '@feedbouncer/scan/contract';

const FAILURE_COPY: Record<ScanFailure, string> = {
  access_revoked: 'Facebook access was removed before the scan finished. Connect again to retry.',
  missing_permissions:
    'The scan needs permissions that were not granted. Connect again and allow every permission.',
  insufficient_page_role:
    'Your Facebook account needs a role on this Page that can read its ads. Ask a Page admin, or pick another Page.',
  rate_limited: 'Facebook asked us to slow down. Try again in a few minutes.',
  platform_unavailable: 'Facebook was unavailable during the scan. Try again shortly.',
  classifier_unavailable: 'Our comment classifier was unavailable. Try again shortly.',
  timeout: 'The scan took too long and was stopped. Try again, or pick a Page with fewer ads.',
  internal: 'Something went wrong on our side. Try again.',
};

const CALLBACK_COPY: Record<string, string> = {
  declined: 'You did not allow access, so nothing was scanned.',
  state_invalid: 'That sign-in link expired or was already used. Start again.',
  missing_permissions: 'Some required permissions were not granted.',
  platform_unavailable: 'Facebook was unavailable. Try again shortly.',
  internal: FAILURE_COPY.internal,
};

const lookup = (table: Record<string, string>, key: string | null): string | null =>
  key !== null && Object.hasOwn(table, key) ? (table[key] ?? null) : null;

// Only known codes map to text, so a crafted ?error= value is never echoed.
export const errorCopy = (code: string | null): string | null =>
  lookup(FAILURE_COPY, code) ?? lookup(CALLBACK_COPY, code);

const SCOPE_COPY: Record<string, string> = {
  pages_show_list: 'See the Pages you manage',
  pages_read_engagement: 'Read Page posts and comments',
  pages_read_user_content: 'Read comments people leave on your Page',
  ads_read: 'Read your ads and the comments on them',
};

export const scopeLabel = (scope: string): string | null => lookup(SCOPE_COPY, scope);

export const NOTICE_COPY: Record<ScanNotice, string> = {
  sampled_comment_cap: 'This result is based on a sample: we read only the most recent comments.',
  sampled_time_limit: 'This result is based on a sample: the scan stopped at its time limit.',
  partial_rate_limited: 'Facebook slowed us down, so some comments were not read.',
  partial_platform_unavailable: 'Facebook was unavailable for some ads, so they are missing.',
  instagram_not_included: 'Instagram comments were not included.',
  deleted_not_visible: 'Comments that were already deleted cannot be seen.',
};

export const CATEGORY_LABEL: Record<ScanCategory, string> = {
  scam_phishing: 'Scam or phishing',
  spam: 'Spam',
};

export const TAG_LABEL: Record<ScanTag, string> = {
  crypto_investment: 'Crypto or investment',
  fake_giveaway: 'Fake giveaway',
  phishing_link: 'Suspicious link',
  impersonation: 'Impersonation',
  generic: 'Other',
};
