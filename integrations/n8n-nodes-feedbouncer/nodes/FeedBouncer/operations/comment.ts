import { NodeOperationError } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { DEFAULT_LIMIT } from '../../shared/constants';
import { assertUuid } from '../../shared/ids';
import { collectPages } from '../../shared/pagination';
import { feedBouncerRequest } from '../../shared/transport';

const SEARCH_MIN = 2;
const SEARCH_MAX = 200;

interface CommentPage {
  data: IDataObject[];
  nextCursor: string | null;
}

function isoWithOffset(ctx: IExecuteFunctions, value: unknown, label: string, i: number): string {
  const date = new Date(String(value));
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
  if (filters.postedAfter) qs.postedFrom = isoWithOffset(ctx, filters.postedAfter, 'Posted After', i);
  if (filters.postedBefore) qs.postedTo = isoWithOffset(ctx, filters.postedBefore, 'Posted Before', i);
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
        await feedBouncerRequest<CommentPage>(this, {
          method: 'GET',
          path: '/v1/comments',
          qs: { ...filters, limit, ...(cursor && { cursor }) },
          operationId: 'listComments',
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
