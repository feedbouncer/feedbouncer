import { apiInternalUrl } from './api-url';
import { forwardToApi } from './api-proxy';

// The route handler behind /api/auth/*, /api/v1/* and /v1/*.
export async function apiRoute(req: Request): Promise<Response> {
  const api = apiInternalUrl();
  if (!api) throw new Error('API_INTERNAL_URL is not configured');
  return forwardToApi(req, api);
}
