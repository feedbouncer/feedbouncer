import { NodeOperationError } from 'n8n-workflow';
import type { INode } from 'n8n-workflow';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

export function assertUuid(
  ctx: { getNode(): INode },
  value: unknown,
  label: string,
  itemIndex?: number,
): string {
  if (!isUuid(value)) {
    throw new NodeOperationError(ctx.getNode(), `${label} must be a FeedBouncer ID (a UUID).`, { itemIndex });
  }
  return value;
}

export function idempotencyKey(parts: {
  executionId: string;
  nodeId: string;
  runIndex: number;
  itemIndex: number;
  operation: string;
  targetId: string;
}): string {
  const { executionId, nodeId, runIndex, itemIndex, operation, targetId } = parts;
  return `n8n.${executionId}.${nodeId}.${runIndex}.${itemIndex}.${operation}.${targetId}`
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .slice(0, 128);
}
