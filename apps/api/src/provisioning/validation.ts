import type { z } from 'zod';
import { ApiError, type ErrorIssue } from '../http/errors.js';

type IssueMessage = 'required' | 'invalid' | 'too_long' | 'unknown_field';

/**
 * Validates a provisioning request body. One issue per top-level field, the first
 * found, naming what is wrong with it but never the submitted value. Build schemas
 * with z.strictObject.
 */
export function parseProvisioningBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const input = body ?? {};
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fields = typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const seen = new Map<string, ErrorIssue>();
  const add = (path: string, message: IssueMessage) => {
    if (!seen.has(path)) seen.set(path, { path, message });
  };
  for (const issue of r.error.issues) {
    const field = issue.path[0];
    const path = field === undefined ? 'body' : String(field);
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) add(field === undefined ? key : path, 'unknown_field');
    } else if (issue.code === 'invalid_type' && field !== undefined && fields[path] === undefined) {
      add(path, 'required');
    } else {
      add(path, issue.code === 'too_big' ? 'too_long' : 'invalid');
    }
  }
  const issues = [...seen].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, issue]) => issue);
  throw new ApiError(400, 'invalid_request', 'Invalid fields.', { issues });
}
