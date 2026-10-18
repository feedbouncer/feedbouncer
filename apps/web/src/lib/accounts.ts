// Logic behind AccountPicker, kept free of React so it can be tested directly.
import { outcomeSentence, outcomeText } from './messages';
import type { ConnectablePlatform } from './platforms';

/** One account offered after sign-in (GET .../connections/:platform/grants/:grantId). */
export interface PickerAccount {
  externalAccountId: string;
  displayName: string | null;
  eligible: boolean;
  ineligibleReason: string | null;
  limitations: string[];
  connection: 'this_brand' | 'elsewhere' | null;
}

const INELIGIBLE: Record<string, string> = {
  no_linked_instagram_account: 'No Instagram professional account is linked to this Page',
  insufficient_page_role:
    'You need full control of this Page, or Facebook access with the Moderate task. Ask a Page admin to grant it in Meta Business Suite → Settings → Page access, then connect again.',
  ad_account_disabled: 'This ad account is disabled in Meta',
  ad_account_unsettled: 'This ad account has an unsettled balance',
  ad_account_closed: 'This ad account is closed',
  ad_account_unavailable: "This ad account can't be used right now",
};

const LIMITATIONS: Record<string, string> = {
  no_messaging_task: "Private replies won't be available",
  messaging_permission_missing:
    "Private replies won't be available (messaging permission not granted)",
};

const own = (table: Record<string, string>, key: string | null): string | undefined =>
  key !== null && Object.hasOwn(table, key) ? table[key] : undefined;

export const isSelectable = (a: PickerAccount): boolean =>
  a.eligible && a.connection !== 'elsewhere';

/** Notes shown next to an account, most important first. */
export function accountNotes(a: PickerAccount, platform: ConnectablePlatform): string[] {
  if (!a.eligible)
    return [own(INELIGIBLE, a.ineligibleReason) ?? 'You need a role that can moderate this Page'];
  if (a.connection === 'elsewhere') return [outcomeSentence('connected_elsewhere', platform)];
  const notes: string[] = [];
  if (a.connection === 'this_brand') notes.push('Connected; selecting it refreshes access');
  for (const l of a.limitations) {
    const t = own(LIMITATIONS, l);
    if (t !== undefined) notes.push(t);
  }
  return notes;
}

export const nothingEligible = (accounts: readonly PickerAccount[]): boolean =>
  accounts.every((a) => !a.eligible);

/** The review-mode choice at connect: on by default; off only once the risk is acknowledged. */
export interface ReviewModeChoiceState {
  on: boolean;
  acknowledged: boolean;
}

export const canConnect = (r: ReviewModeChoiceState): boolean => r.on || r.acknowledged;

export function connectRequest(
  orgId: string,
  brandId: string,
  platform: ConnectablePlatform,
  grantId: string,
  accountIds: string[],
  reviewMode: ReviewModeChoiceState = { on: true, acknowledged: false },
): {
  path: `/api/${string}`;
  body: { accountIds: string[]; reviewMode?: 'off'; acknowledgeRisk?: true };
} {
  return {
    path: `/api/v1/orgs/${orgId}/brands/${brandId}/connections/${platform}/grants/${grantId}/connect`,
    body: reviewMode.on ? { accountIds } : { accountIds, reviewMode: 'off', acknowledgeRisk: true },
  };
}

export function connectResultText(status: string, platform: ConnectablePlatform): string {
  if (status === 'connected') return 'Connected';
  if (status === 'reconnected') return 'Reconnected';
  return `Not connected: ${outcomeText(status, platform)}`;
}
