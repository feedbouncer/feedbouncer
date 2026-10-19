import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { CREDENTIAL_NAME, DEFAULT_LIMIT } from '../../shared/constants';
import { describeFailure, toNodeApiError } from '../../shared/errors';
import { assertUuid } from '../../shared/ids';
import { collectPages } from '../../shared/pagination';
import { feedBouncerRequest } from '../../shared/transport';

interface RuleSet {
  brands: Array<{ id: string; name: string; rules: IDataObject[] }>;
}

/** One entry per rule, brands in API order and rules in evaluation order. Rule-change proposals are left out. */
function flatten({ brands }: RuleSet): IDataObject[] {
  return brands.flatMap(({ id, name, rules }) => rules.map((rule) => ({ ...rule, brandId: id, brandName: name })));
}

export async function executeRule(
  this: IExecuteFunctions,
  operation: 'get' | 'list',
  i: number,
): Promise<INodeExecutionData[]> {
  const pairedItem = { item: i };
  const brandParam = this.getNodeParameter('brandId', i, '') as string;
  const qs: IDataObject = brandParam ? { brandId: assertUuid(this, brandParam, 'Brand ID', i) } : {};
  const ruleId = operation === 'get' ? assertUuid(this, this.getNodeParameter('ruleId', i), 'Rule ID', i) : undefined;

  const { body } = await feedBouncerRequest<RuleSet>(this, {
    method: 'GET',
    path: '/v1/rules',
    qs,
    operationId: 'listRules',
    resourceLabel: 'rule',
    id: ruleId,
    itemIndex: i,
  });
  const rules = flatten(body);

  if (ruleId !== undefined) {
    const found = rules.find((rule) => rule.id === ruleId);
    if (!found) {
      const info = describeFailure({
        status: 404,
        body: { error: { code: 'not_found', message: '' } },
        credentialName: this.getNode().credentials?.[CREDENTIAL_NAME]?.name ?? 'FeedBouncer API',
        resourceLabel: 'rule',
        id: ruleId,
      });
      throw toNodeApiError(this.getNode(), info, i);
    }
    return [{ json: found, pairedItem }];
  }

  const offset = (cursor?: string) => (cursor ? Number(cursor) : 0);
  const selected = await collectPages<IDataObject>(
    async (cursor, pageLimit) => {
      const start = offset(cursor);
      const end = start + pageLimit;
      return { data: rules.slice(start, end), nextCursor: end < rules.length ? String(end) : null };
    },
    {
      returnAll: this.getNodeParameter('returnAll', i) as boolean,
      limit: this.getNodeParameter('limit', i, DEFAULT_LIMIT) as number,
    },
  );
  return selected.map((json) => ({ json, pairedItem }));
}
