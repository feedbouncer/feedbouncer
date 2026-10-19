import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { CREDENTIAL_NAME } from '../shared/constants';
import { ReturnAllLimitError } from '../shared/pagination';
import { commentDescription } from './descriptions/comment';
import { executeComment } from './operations/comment';

export class FeedBouncer implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'FeedBouncer',
    name: 'feedBouncer',
    icon: { light: 'file:feedbouncer.svg', dark: 'file:feedbouncer.dark.svg' },
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Read and moderate social comments in FeedBouncer',
    defaults: { name: 'FeedBouncer' },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL_NAME, required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Comment', value: 'comment' },
          { name: 'Decision', value: 'decision' },
          { name: 'Rule', value: 'rule' },
        ],
        default: 'comment',
      },
      ...commentDescription,
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const out: INodeExecutionData[] = [];
    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;

    for (let i = 0; i < this.getInputData().length; i++) {
      try {
        if (resource !== 'comment') {
          throw new NodeOperationError(this.getNode(), `Unsupported resource: ${resource}.`, { itemIndex: i });
        }
        out.push(...(await executeComment.call(this, operation as 'get' | 'list', i)));
      } catch (error) {
        const failure =
          error instanceof ReturnAllLimitError
            ? new NodeOperationError(
                this.getNode(),
                'More than 10,000 comments match. Narrow the filters or turn off Return All and set a Limit.',
                { itemIndex: i },
              )
            : error;
        if (!this.continueOnFail()) throw failure;
        const { message, description, httpCode } = failure as {
          message: string;
          description?: string;
          httpCode?: string;
        };
        out.push({ json: { error: message, description, httpCode }, pairedItem: { item: i } });
      }
    }
    return [out];
  }
}
