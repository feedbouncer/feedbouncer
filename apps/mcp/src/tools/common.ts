import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Logger } from '@feedbouncer/service-runtime';
import { ApiCallError, type ApiPort } from '../api-client.js';
import { toToolError } from '../errors.js';

export interface ToolDeps {
  api: ApiPort;
  log: Logger;
  pollIntervalMs: number;
  replyWaitMs: number;
}

export const timestamp = z.iso.datetime({ offset: true });
export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/)
  .optional()
  .describe('Optional retry key; reuse it to make a retried call safe.');

const PLATFORM_NAME: Readonly<Record<string, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
};

/** Display name of a platform; one the server does not know yet is shown as the API names it. */
export const platformName = (platform: string): string =>
  Object.hasOwn(PLATFORM_NAME, platform) ? PLATFORM_NAME[platform]! : platform;

/** Turns a failed or not-eligible action into the same error text an API error would get. */
export function actionError(
  action: { status: string; code: string | null },
  platform: string,
): { result: CallToolResult; code: string } {
  const code = action.code ?? action.status;
  const err = new ApiCallError(422, code, code, { platform: platformName(platform) });
  return { result: toToolError(err), code };
}

export interface Outcome {
  result: CallToolResult;
  /** Short status for the log line; never contains text bodies. */
  outcome: string;
}

export const text = (...lines: string[]): CallToolResult['content'] =>
  lines.map((t) => ({ type: 'text' as const, text: t }));

/** Runs a tool body, converting failures to tool errors and logging one line per call. */
export async function runTool(
  deps: ToolDeps,
  tool: string,
  targetId: string | undefined,
  body: () => Promise<Outcome>,
): Promise<CallToolResult> {
  let done: Outcome;
  try {
    done = await body();
  } catch (e) {
    done = {
      result: toToolError(e),
      outcome: e instanceof ApiCallError ? e.code : 'internal_error',
    };
  }
  const fields = { tool, targetId: targetId ?? null, outcome: done.outcome };
  if (done.result.isError) deps.log.warn('tool call failed', fields);
  else deps.log.info('tool call', fields);
  return done.result;
}
