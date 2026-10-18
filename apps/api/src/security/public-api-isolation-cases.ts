import type { OrgFixture } from '../testing/harness.js';

export interface PublicIsolationFixture {
  A: OrgFixture;
  B: OrgFixture;
  /** A write-scoped API key of A. */
  aWriteToken: string;
  bCommentId: string;
}

export interface PublicApiCase {
  /** The route as documented, "METHOD /v1/path/{param}". */
  route: `${'GET' | 'POST' | 'PATCH' | 'DELETE'} /v1/${string}`;
  url: (f: PublicIsolationFixture) => string;
  body?: (f: PublicIsolationFixture) => unknown;
}

/** Every /v1 route with a path parameter, aimed at B's resources with A's write key. */
export const PUBLIC_API_CASES: readonly PublicApiCase[] = [
  { route: 'GET /v1/comments/{id}', url: (f) => `/v1/comments/${f.bCommentId}` },
];
