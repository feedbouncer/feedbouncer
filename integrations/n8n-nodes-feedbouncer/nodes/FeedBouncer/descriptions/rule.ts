import type { INodeProperties } from 'n8n-workflow';

const forRule = { resource: ['rule'] };

export const ruleDescription: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: forRule },
    options: [
      { name: 'Get', value: 'get', action: 'Get a rule', description: 'Get one rule by ID' },
      { name: 'Get Many', value: 'list', action: 'Get many rules', description: 'List live rules in evaluation order' },
    ],
    default: 'get',
  },
  {
    displayName: 'Rule ID',
    name: 'ruleId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { ...forRule, operation: ['get'] } },
    description: 'The FeedBouncer ID of the rule',
  },
  {
    displayName: 'Brand ID',
    name: 'brandId',
    type: 'string',
    default: '',
    displayOptions: { show: forRule },
    description: 'Only look at the rules of this brand. Leave empty for all brands.',
  },
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    displayOptions: { show: { ...forRule, operation: ['list'] } },
    description: 'Whether to return all results or only up to a given limit',
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    typeOptions: { minValue: 1 },
    default: 50,
    displayOptions: { show: { ...forRule, operation: ['list'], returnAll: [false] } },
    description: 'Max number of results to return',
  },
];
