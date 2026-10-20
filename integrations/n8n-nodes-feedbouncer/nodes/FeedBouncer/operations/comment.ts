import { NodeOperationError } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { DEFAULT_LIMIT } from '../../shared/constants';
import { assertUuid } from '../../shared/ids';
import { collectPages, type Page } from '../../shared/pagination';
import { feedBouncerRequest } from '../../shared/transport';

const SEARCH_MIN = 2;
const SEARCH_MAX = 200;

const ZONELESS_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wallClockAsUtc - Math.floor(utcMs / 1000) * 1000;
}

function parseInTimezone(value: string, timeZone: string): Date {
  if (!ZONELESS_DATE.test(value)) return new Date(value);
  const wallClockAsUtc = Date.parse(value.includes('T') ? `${value}Z` : `${value}T00:00:00Z`);
  const approximate = wallClockAsUtc - zoneOffsetMs(wallClockAsUtc, timeZone);
  return new Date(wallClockAsUtc - zoneOffsetMs(approximate, timeZone));
}

function toUtcIso(ctx: IExecuteFunctions, value: unknown, label: string, i: number): string {
  const date = parseInTimezone(String(value), ctx.getTimezone());
  if (Number.isNaN(date.getTime())) {
    throw new NodeOperationError(ctx.getNode(), `${label} is not a valid date.`, { itemIndex: i });
  }
  return date.toISOString();
}

function listQuery(ctx: IExecuteFunctions, i: number): IDataObject {
  const filters = ctx.getNodeParameter('filters', i, {}) as IDataObject;
  const qs: IDataObject = {};
  for (const name of ['status', 'brandId', 'platform'] as const) {
    if (filters[name]) qs[name] = filters[name];
  }
  if (filters.brandId) assertUuid(ctx, filters.brandId, 'Brand ID', i);
  if (filters.search !== undefined && filters.search !== '') {
    const length = Array.from(String(filters.search)).length;
    if (length < SEARCH_MIN || length > SEARCH_MAX) {
      throw new NodeOperationError(ctx.getNode(), 'Search must be 2 to 200 characters.', { itemIndex: i });
    }
    qs.q = filters.search;
  }
  if (filters.postedAfter) qs.postedFrom = toUtcIso(ctx, filters.postedAfter, 'Posted After', i);
  if (filters.postedBefore) qs.postedTo = toUtcIso(ctx, filters.postedBefore, 'Posted Before', i);
  return qs;
}

export async function executeComment(
  this: IExecuteFunctions,
  operation: 'get' | 'list',
  i: number,
): Promise<INodeExecutionData[]> {
  const pairedItem = { item: i };

  if (operation === 'get') {
    const id = assertUuid(this, this.getNodeParameter('commentId', i), 'Comment ID', i);
    const { body } = await feedBouncerRequest<IDataObject>(this, {
      method: 'GET',
      path: `/v1/comments/${encodeURIComponent(id)}`,
      operationId: 'getComment',
      resourceLabel: 'comment',
      id,
      itemIndex: i,
    });
    return [{ json: body, pairedItem }];
  }

  const filters = listQuery(this, i);
  const comments = await collectPages<IDataObject>(
    async (cursor, limit) =>
      (
        await feedBouncerRequest<Page<IDataObject>>(this, {
          method: 'GET',
          path: '/v1/comments',
          qs: { ...filters, limit, ...(cursor && { cursor }) },
          operationId: 'listComments',
          ...(filters.brandId ? { resourceLabel: 'brand', id: filters.brandId as string } : {}),
          itemIndex: i,
        })
      ).body,
    {
      returnAll: this.getNodeParameter('returnAll', i) as boolean,
      limit: this.getNodeParameter('limit', i, DEFAULT_LIMIT) as number,
    },
  );
  return comments.map((json) => ({ json, pairedItem }));
}
