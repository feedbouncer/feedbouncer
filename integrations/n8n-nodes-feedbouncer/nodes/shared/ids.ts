import { NodeOperationError } from 'n8n-workflow';
import type { INode } from 'n8n-workflow';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(
  ctx: { getNode(): INode },
  value: unknown,
  label: string,
  itemIndex?: number,
): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new NodeOperationError(ctx.getNode(), `${label} must be a FeedBouncer ID (a UUID).`, { itemIndex });
  }
  return value;
}

export function idempotencyKey(parts: {
  executionId: string;
  nodeId: string;
  itemIndex: number;
  operation: string;
}): string {
  const { executionId, nodeId, itemIndex, operation } = parts;
  return `n8n.${executionId}.${nodeId}.${itemIndex}.${operation}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
}
