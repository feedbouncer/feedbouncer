import type { OrgFixture } from '../testing/harness.js';

export interface PublicIsolationFixture {
  A: OrgFixture;
  B: OrgFixture;
  /** A write-scoped API key of A. */
  aWriteToken: string;
  bCommentId: string;
  bReviewItemId: string;
  /** A settled moderation action on B's comment. */
  bActionId: string;
  aEndpointId: string;
  bEndpointId: string;
  bDeliveryId: string;
}

export interface PublicApiCase {
  /** The route as documented, "METHOD /v1/path/{param}". */
  route: `${'GET' | 'POST' | 'PATCH' | 'DELETE'} /v1/${string}`;
  url: (f: PublicIsolationFixture) => string;
  /** Tells apart several cases of one route. */
  label?: string;
  body?: (f: PublicIsolationFixture) => unknown;
}

/** Every /v1 route with a path parameter, aimed at B's resources with A's write key. */
export const PUBLIC_API_CASES: readonly PublicApiCase[] = [
  { route: 'GET /v1/comments/{id}', url: (f) => `/v1/comments/${f.bCommentId}` },
  { route: 'GET /v1/flagged-items/{id}', url: (f) => `/v1/flagged-items/${f.bReviewItemId}` },
  {
    route: 'POST /v1/comments/{id}/hide',
    url: (f) => `/v1/comments/${f.bCommentId}/hide`,
  },
  {
    route: 'POST /v1/comments/{id}/unhide',
    url: (f) => `/v1/comments/${f.bCommentId}/unhide`,
  },
  {
    route: 'POST /v1/comments/{id}/replies',
    url: (f) => `/v1/comments/${f.bCommentId}/replies`,
    body: () => ({ text: 'taken over' }),
  },
  { route: 'GET /v1/actions/{id}', url: (f) => `/v1/actions/${f.bActionId}` },
  { route: 'GET /v1/webhook-endpoints/{id}', url: (f) => `/v1/webhook-endpoints/${f.bEndpointId}` },
  {
    route: 'PATCH /v1/webhook-endpoints/{id}',
    url: (f) => `/v1/webhook-endpoints/${f.bEndpointId}`,
    body: () => ({ description: 'taken over' }),
  },
  {
    route: 'DELETE /v1/webhook-endpoints/{id}',
    url: (f) => `/v1/webhook-endpoints/${f.bEndpointId}`,
  },
  {
    route: 'POST /v1/webhook-endpoints/{id}/rotate-secret',
    url: (f) => `/v1/webhook-endpoints/${f.bEndpointId}/rotate-secret`,
  },
  {
    route: 'POST /v1/webhook-endpoints/{id}/test',
    url: (f) => `/v1/webhook-endpoints/${f.bEndpointId}/test`,
  },
  {
    route: 'GET /v1/webhook-endpoints/{id}/deliveries',
    url: (f) => `/v1/webhook-endpoints/${f.bEndpointId}/deliveries`,
  },
  {
    route: 'POST /v1/webhook-endpoints/{id}/deliveries/{deliveryId}/redeliver',
    label: "B's delivery under B's endpoint",
    url: (f) => `/v1/webhook-endpoints/${f.bEndpointId}/deliveries/${f.bDeliveryId}/redeliver`,
  },
  {
    route: 'POST /v1/webhook-endpoints/{id}/deliveries/{deliveryId}/redeliver',
    label: "B's delivery under A's endpoint",
    url: (f) => `/v1/webhook-endpoints/${f.aEndpointId}/deliveries/${f.bDeliveryId}/redeliver`,
  },
];
