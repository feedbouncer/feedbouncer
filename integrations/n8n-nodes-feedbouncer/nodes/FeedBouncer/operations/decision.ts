import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { ACTION_POLL_MS, ACTION_WAIT_MS } from '../../shared/constants';
import { toNodeApiError } from '../../shared/errors';
import { assertUuid, idempotencyKey, IDEMPOTENCY_KEY_PATTERN } from '../../shared/ids';
import { feedBouncerRequest } from '../../shared/transport';

type DecisionOperation = 'hide' | 'undoHide';

interface ActionSummary {
  id: string;
  kind: string;
  status: string;
  code: string | null;
}

interface ModerationResult {
  action: ActionSummary;
  comment: IDataObject;
}

const PATH_SUFFIX = { hide: 'hide', undoHide: 'unhide' } as const;
const OPERATION_ID = { hide: 'hideComment', undoHide: 'unhideComment' } as const;
const VERB = { hide: 'hide', undoHide: 'undo the hide of' } as const;

function requestKey(ctx: IExecuteFunctions, options: IDataObject, operation: DecisionOperation, i: number): string {
  const override = options.idempotencyKey;
  if (override === undefined || override === '') {
    return idempotencyKey({
      executionId: ctx.getExecutionId(),
      nodeId: ctx.getNode().id,
      itemIndex: i,
      operation,
    });
  }
  if (typeof override !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(override)) {
    throw new NodeOperationError(ctx.getNode(), 'Idempotency Key may use 1 to 128 letters, digits and . _ : - only.', {
      itemIndex: i,
    });
  }
  return override;
}

async function waitForAction(ctx: IExecuteFunctions, action: ActionSummary, i: number): Promise<ActionSummary> {
  let current = action;
  for (let waited = 0; current.status === 'pending' && waited < ACTION_WAIT_MS; waited += ACTION_POLL_MS) {
    await sleep(ACTION_POLL_MS);
    const { body } = await feedBouncerRequest<IDataObject>(ctx, {
      method: 'GET',
      path: `/v1/actions/${encodeURIComponent(action.id)}`,
      operationId: 'getAction',
      resourceLabel: 'action',
      id: action.id,
      itemIndex: i,
    });
    current = { ...action, status: String(body.status), code: (body.code as string | null) ?? null };
  }
  return current;
}

/** The API's own words for an unsupported undo go into the description. */
function explainUnsupportedUndo(ctx: IExecuteFunctions, error: unknown, i: number): unknown {
  if (!(error instanceof NodeApiError) || error.httpCode !== '422' || !error.description?.endsWith('unsupported_action.')) {
    return error;
  }
  return toNodeApiError(
    ctx.getNode(),
    { httpCode: 422, code: 'unsupported_action', message: "This hide can't be undone on its platform.", description: error.message },
    i,
  );
}

export async function executeDecision(
  this: IExecuteFunctions,
  operation: DecisionOperation,
  i: number,
): Promise<INodeExecutionData[]> {
  const id = assertUuid(this, this.getNodeParameter('commentId', i), 'Comment ID', i);
  const options = this.getNodeParameter('options', i, {}) as IDataObject;
  const key = requestKey(this, options, operation, i);

  let result: ModerationResult;
  let status: number;
  try {
    const response = await feedBouncerRequest<ModerationResult>(this, {
      method: 'POST',
      path: `/v1/comments/${encodeURIComponent(id)}/${PATH_SUFFIX[operation]}`,
      idempotencyKey: key,
      operationId: OPERATION_ID[operation],
      resourceLabel: 'comment',
      id,
      itemIndex: i,
    });
    result = response.body;
    status = response.status;
  } catch (error) {
    throw operation === 'undoHide' ? explainUnsupportedUndo(this, error, i) : error;
  }

  let { action } = result;
  if (status === 202 && options.waitForResult !== false) action = await waitForAction(this, action, i);

  if (action.status === 'failed' || action.status === 'not_eligible') {
    const code = action.code ?? action.status;
    const error = toNodeApiError(
      this.getNode(),
      {
        httpCode: null,
        code,
        message: `FeedBouncer could not ${VERB[operation]} comment ${id}: ${code}.`,
        description: 'The platform did not apply the change.',
      },
      i,
    );
    error.context = { ...error.context, code };
    throw error;
  }

  const { id: actionId, kind, status: finalStatus, code } = action;
  return [
    {
      json: {
        action: { id: actionId, kind, status: finalStatus, code },
        comment: result.comment,
        changed: finalStatus === 'applied' || finalStatus === 'pending',
      },
      pairedItem: { item: i },
    },
  ];
}
