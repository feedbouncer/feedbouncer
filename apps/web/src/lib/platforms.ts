// Platforms whose accounts are connected through the OAuth connect flow and
// the account picker. The API decides whether each one is configured; the web
// app only knows their names and copy.
export const CONNECTABLE = ['facebook', 'instagram', 'meta_ads', 'tiktok', 'tiktok_ads'] as const;
export type ConnectablePlatform = (typeof CONNECTABLE)[number];

export function isConnectable(p: string): p is ConnectablePlatform {
  return (CONNECTABLE as readonly string[]).includes(p);
}

export interface PlatformCopy {
  label: string;
  accountNoun: string;
  connectLabel: string;
  pickerTitle: string;
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
    pickerTitle: 'Choose Pages',
    viewOn: 'View on Facebook',
    deleteConfirm: 'Delete this comment on Facebook? This cannot be undone.',
    pickerIntro: 'Choose the Facebook Pages to connect.',
    noEligible:
      'You do not have a role that can moderate any of these Pages. Ask a Page admin to give you full control or Facebook access with the Moderate task in Meta Business Suite → Settings → Page access, then connect again.',
  },
  instagram: {
    label: 'Instagram',
    accountNoun: 'Instagram account',
    connectLabel: 'Connect Instagram account',
    pickerTitle: 'Choose Instagram accounts',
    viewOn: 'View on Instagram',
    deleteConfirm: "Delete this comment on Instagram? This can't be undone.",
    pickerIntro: 'Choose the Facebook Page your Instagram professional account is linked to.',
    noEligible:
      'None of your Facebook Pages has a linked Instagram professional account. Link your Instagram Business or Creator account to a Facebook Page in Meta Business Suite, then connect again.',
  },
  meta_ads: {
    label: 'Meta ad account',
    accountNoun: 'ad account',
    connectLabel: 'Connect ad account',
    pickerTitle: 'Choose ad accounts',
    viewOn: 'View in Ads Manager',
    deleteConfirm: "Delete this comment? This can't be undone.",
    pickerIntro: 'Choose the ad accounts whose ads you want to moderate.',
    noEligible:
      'None of your ad accounts can be used right now. Check that you have access to an active ad account in Meta Business Suite, then connect again.',
  },
  tiktok: {
    label: 'TikTok account',
    accountNoun: 'TikTok account',
    connectLabel: 'Connect TikTok account',
    pickerTitle: 'Choose TikTok account',
    viewOn: 'View on TikTok',
    deleteConfirm: "Delete this comment on TikTok? This can't be undone.",
    pickerIntro: 'Confirm the TikTok business account to connect.',
    noEligible:
      'This TikTok account cannot be connected. Use a TikTok Business account, then connect again.',
  },
  tiktok_ads: {
    label: 'TikTok ad account',
    accountNoun: 'TikTok ad account',
    connectLabel: 'Connect TikTok ads',
    pickerTitle: 'Choose TikTok ad accounts',
    viewOn: 'View on TikTok',
    deleteConfirm: "Delete this comment on TikTok? This can't be undone.",
    pickerIntro: 'Choose the TikTok ad accounts whose ads belong to this brand.',
    noEligible:
      'None of your TikTok ad accounts can be used right now. Check your access in TikTok Ads Manager, then connect again.',
  },
};
