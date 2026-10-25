import type { QuotaMeter } from '@feedbouncer/connectors';
import type { Secret } from '@feedbouncer/service-runtime';

/** The connector's own name for the scope; Google's URL form appears only in the consent URL. */
export const YOUTUBE_SCOPE_SHORT = 'youtube.force-ssl';
export const YOUTUBE_SCOPE_URL = 'https://www.googleapis.com/auth/youtube.force-ssl';
export const API_HOSTS: readonly string[] = ['www.googleapis.com', 'oauth2.googleapis.com'];
export const AUTH_HOSTS: readonly string[] = ['accounts.google.com'];

export interface YouTubeConnectorConfig {
  readonly clientId: string;
  readonly clientSecret: Secret;
  /** Meters OAuth-time calls (purpose `connect`), which have no connection yet. */
  readonly projectQuota?: QuotaMeter;
}
