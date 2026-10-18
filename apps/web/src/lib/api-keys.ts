import { ApiRequestError } from './api-client';
import { formatUtc } from './format';

export type ApiKeyScope = 'read' | 'write';

/** A key as the API returns it: the public prefix only, never the secret. */
export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  status: 'active' | 'revoked';
  createdAt: string;
  createdBy: { name: string } | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const ACCESS_OPTIONS = [
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Read and write' },
] as const;

export const accessText = (scope: ApiKeyScope): string =>
  ACCESS_OPTIONS.find((o) => o.value === scope)!.label;

export const statusText = (status: ApiKeyDto['status']): string =>
  status === 'active' ? 'Active' : 'Revoked';

export const lastUsedText = (iso: string | null): string => (iso ? formatUtc(iso) : 'Never');

export const revokeConfirmText = (name: string): string =>
  `Revoke ${name}? Apps using this key will stop working immediately.`;

export const apiKeyErrorText = (err: unknown): string =>
  err instanceof ApiRequestError ? err.message : 'Something went wrong.';
