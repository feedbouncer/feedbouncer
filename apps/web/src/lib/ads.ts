// Copy for ads the API reports as tracked, and the shape of GET .../ads.
export interface AdView {
  adId: string;
  adAccountId: string;
  effectiveStatus: string;
  active: boolean;
  inactiveSince: string | null;
  facebook: { resolution: string; postId: string | null };
  instagram: { resolution: string; mediaId: string | null };
  lastDiscoveredAt: string;
  lastPolledAt: string | null;
  postUnavailable: boolean;
}

const RESOLUTIONS: Record<string, string> = {
  linked: 'Moderated',
  page_not_connected: 'Connect the Facebook Page that runs this ad',
  instagram_account_not_connected: 'Connect the Instagram account that runs this ad',
  instagram_media_pending: 'Waiting for Instagram to publish this ad',
  no_post: 'This ad type has no post to moderate',
  dynamic_creative_unsupported: 'Catalog ads are not supported yet',
  post_deleted: "The ad's post was deleted",
  invalid_platform_id: 'Meta returned an unexpected id',
  not_instagram: 'Not running on Instagram',
};

export function resolutionText(reason: string): string {
  return Object.hasOwn(RESOLUTIONS, reason) ? RESOLUTIONS[reason]! : 'Unknown reason';
}

export const adBadgeTitle = (a: { adId: string; adAccountId: string }): string =>
  `Ad ${a.adId} · account ${a.adAccountId}`;
