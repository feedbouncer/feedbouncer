export const TIKTOK_API_HOST = 'business-api.tiktok.com';

/** Closed table of reachable paths (relative to /open_api/v1.3/). Callers pass keys, never paths. */
export const TIKTOK_ENDPOINTS = {
  // Marketing API
  adOauthToken: 'oauth2/access_token/',
  adOauthRefresh: 'oauth2/refresh_token/',
  adAdvertiserGet: 'oauth2/advertiser/get/',
  adCommentList: 'comment/list/',
  adCommentStatusUpdate: 'comment/status/update/',
  adCommentDelete: 'comment/delete/',
  adCommentPost: 'comment/post/',
  // TikTok Accounts (unverified, V2-V8: see README)
  ttToken: 'tt_user/oauth2/token/',
  ttRefresh: 'tt_user/oauth2/refresh_token/',
  ttRevoke: 'tt_user/oauth2/revoke/',
  businessGet: 'business/get/',
  businessVideoList: 'business/video/list/',
  businessCommentList: 'business/comment/list/',
  businessReplyList: 'business/comment/reply/list/',
  businessCommentHide: 'business/comment/hide/',
  businessCommentDelete: 'business/comment/delete/',
  businessReplyCreate: 'business/comment/reply/create/',
} as const;
export type TikTokEndpoint = keyof typeof TIKTOK_ENDPOINTS;
