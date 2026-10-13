// Platforms whose accounts are connected through the OAuth connect flow and
// the account picker. The API decides whether each one is configured; the web
// app only knows their names and copy.
export const CONNECTABLE = ['facebook', 'instagram'] as const;
export type ConnectablePlatform = (typeof CONNECTABLE)[number];

export function isConnectable(p: string): p is ConnectablePlatform {
  return (CONNECTABLE as readonly string[]).includes(p);
}

export interface PlatformCopy {
  label: string;
  accountNoun: string;
  connectLabel: string;
  viewOn: string;
  deleteConfirm: string;
  pickerIntro: string;
  noEligible: string;
}

export const PLATFORM_COPY: Record<ConnectablePlatform, PlatformCopy> = {
  facebook: {
    label: 'Facebook',
    accountNoun: 'Facebook Page',
    connectLabel: 'Connect Facebook Page',
    viewOn: 'View on Facebook',
    deleteConfirm: 'Delete this comment on Facebook? This cannot be undone.',
    pickerIntro: 'Choose the Facebook Pages to connect.',
    noEligible:
      'You do not have a role that can moderate any of these Pages. Ask a Page admin for full control or moderation access, then connect again.',
  },
  instagram: {
    label: 'Instagram',
    accountNoun: 'Instagram account',
    connectLabel: 'Connect Instagram account',
    viewOn: 'View on Instagram',
    deleteConfirm: "Delete this comment on Instagram? This can't be undone.",
    pickerIntro: 'Choose the Facebook Page your Instagram professional account is linked to.',
    noEligible:
      'None of your Facebook Pages has a linked Instagram professional account. Link your Instagram Business or Creator account to a Facebook Page in Meta Business Suite, then connect again.',
  },
};
