import type { INodeProperties } from 'n8n-workflow';

const forComment = { resource: ['comment'] };

export const commentDescription: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: forComment },
    options: [
      { name: 'Get', value: 'get', action: 'Get a comment', description: 'Get one comment by ID' },
      { name: 'Get Many', value: 'list', action: 'Get many comments', description: 'List comments, newest first' },
    ],
    default: 'get',
  },
  {
    displayName: 'Comment ID',
    name: 'commentId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { ...forComment, operation: ['get'] } },
    description: 'The FeedBouncer ID of the comment',
  },
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    displayOptions: { show: { ...forComment, operation: ['list'] } },
    description: 'Whether to return all results or only up to a given limit',
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    typeOptions: { minValue: 1 },
    default: 50,
    displayOptions: { show: { ...forComment, operation: ['list'], returnAll: [false] } },
    description: 'Max number of results to return',
  },
  {
    displayName: 'Filters',
    name: 'filters',
    type: 'collection',
    placeholder: 'Add Filter',
    default: {},
    displayOptions: { show: { ...forComment, operation: ['list'] } },
    options: [
      {
        displayName: 'Brand ID',
        name: 'brandId',
        type: 'string',
        default: '',
        description: 'Only comments of this brand',
      },
      {
        displayName: 'Platform',
        name: 'platform',
        type: 'options',
        options: [
          { name: 'Facebook', value: 'facebook' },
          { name: 'Instagram', value: 'instagram' },
        ],
        default: 'facebook',
      },
      {
        displayName: 'Posted After',
        name: 'postedAfter',
        type: 'dateTime',
        default: '',
      },
      {
        displayName: 'Posted Before',
        name: 'postedBefore',
        type: 'dateTime',
        default: '',
      },
      {
        displayName: 'Search',
        name: 'search',
        type: 'string',
        default: '',
        description: 'Text to look for in the comment, 2 to 200 characters',
      },
      {
        displayName: 'Status',
        name: 'status',
        type: 'options',
        options: [
          { name: 'Flagged', value: 'flagged' },
          { name: 'Hidden', value: 'hidden' },
          { name: 'Replied', value: 'replied' },
          { name: 'Unanswered', value: 'unanswered' },
          { name: 'Visible', value: 'visible' },
        ],
        default: 'visible',
      },
    ],
  },
];
