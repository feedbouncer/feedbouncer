import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  INode,
  IWebhookFunctions,
} from 'n8n-workflow';

export const API_KEY = `fbk_aaaaaaaaaaaaaaaa_${'A'.repeat(43)}`;

export const DEFAULT_CREDENTIALS = {
  baseUrl: 'https://fb.acme.io',
  apiKey: API_KEY,
  allowHttp: false,
  allowUnauthorizedCerts: false,
};

/** Milliseconds passed to the mocked `sleep` from n8n-workflow. */
export const slept: number[] = [];

export type Scripted =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { throw: { code: string } };

export interface RecordedCall {
  authenticated: boolean;
  method: string;
  url: string;
  qs?: IDataObject;
  body?: IDataObject;
  headers: Record<string, string>;
  options: Record<string, unknown>;
}

export interface FakeInit {
  params?: Record<string, unknown>;
  items?: IDataObject[];
  credentials?: Record<string, unknown> | null;
  http?: Scripted[];
  credentialName?: string;
  executionId?: string;
  staticData?: IDataObject;
}

const NODE: INode = {
  id: 'node-1',
  name: 'FeedBouncer',
  type: 'n8n-nodes-feedbouncer.feedBouncer',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

/** Fails like a real HTTP client would: the error carries the full request config, key included. */
function leakyError(code: string, options: Record<string, unknown>, apiKey: string): Error {
  const config = { ...options, headers: { ...(options.headers as object), Authorization: `Bearer ${apiKey}` } };
  const error = Object.assign(new Error(`request to ${String(options.url)} failed (${code}); Authorization: Bearer ${apiKey}`), {
    code,
    config,
    request: { headers: config.headers },
    cause: { code, config },
  });
  return error;
}

function build(init: FakeInit) {
  const queue = [...(init.http ?? [])];
  const calls: RecordedCall[] = [];
  const credentials = init.credentials === undefined ? DEFAULT_CREDENTIALS : init.credentials;
  const apiKey = String((credentials as Record<string, unknown> | null)?.apiKey ?? API_KEY);
  const node: INode = {
    ...NODE,
    credentials: { feedBouncerApi: { id: '1', name: init.credentialName ?? 'FeedBouncer API' } },
  };
  const staticData: IDataObject = init.staticData ?? {};

  const send = (authenticated: boolean) =>
    async function (this: unknown, ...args: unknown[]) {
      const options = args[args.length - 1] as Record<string, unknown>;
      const headers = (options.headers ?? {}) as Record<string, string>;
      calls.push({
        authenticated,
        method: String(options.method),
        url: String(options.url),
        qs: options.qs as IDataObject | undefined,
        body: options.body as IDataObject | undefined,
        headers,
        options,
      });
      const next = queue.shift();
      if (!next) throw new Error('fake http queue is empty');
      if ('throw' in next) throw leakyError(next.throw.code, options, apiKey);
      if (next.status >= 400 && !options.ignoreHttpStatusErrors) {
        throw leakyError(`HTTP_${next.status}`, options, apiKey);
      }
      return { statusCode: next.status, headers: next.headers ?? {}, body: next.body };
    };

  const ctx = {
    calls,
    staticData,
    getNode: () => node,
    getCredentials: async () => {
      if (credentials === null) throw new Error('no credentials');
      return { ...credentials };
    },
    getNodeParameter: (name: string, _index?: unknown, fallback?: unknown) =>
      init.params && name in init.params ? init.params[name] : fallback,
    getExecutionId: () => init.executionId ?? '123',
    getWorkflowStaticData: () => staticData,
    getInputData: () => (init.items ?? [{}]).map((json) => ({ json })),
    continueOnFail: () => false,
    helpers: {
      httpRequestWithAuthentication: send(true),
      httpRequest: send(false),
      returnJsonArray: (data: IDataObject | IDataObject[]) =>
        (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
    },
  };
  return ctx;
}

export type FakeContext = ReturnType<typeof build>;

export function fakeExecute(init: FakeInit = {}): IExecuteFunctions & FakeContext {
  return build(init) as unknown as IExecuteFunctions & FakeContext;
}

export function fakeHook(init: FakeInit & { webhookUrl?: string } = {}): IHookFunctions & FakeContext {
  const ctx = build(init);
  return Object.assign(ctx, {
    getWorkflow: () => ({ id: 'wf-1' }),
    getNodeWebhookUrl: () => init.webhookUrl ?? 'https://n8n.example.com/webhook/abc',
    getMode: () => 'trigger',
    getActivationMode: () => 'activate',
  }) as unknown as IHookFunctions & FakeContext;
}

export function fakeWebhook(
  init: FakeInit & { headers?: Record<string, string>; rawBody?: string | Buffer } = {},
): IWebhookFunctions & FakeContext {
  const ctx = build(init);
  const rawBody = Buffer.from(init.rawBody ?? '');
  const headers = init.headers ?? {};
  return Object.assign(ctx, {
    getHeaderData: () => headers,
    getRequestObject: () => ({ rawBody, headers }),
    getBodyData: () => JSON.parse(rawBody.toString('utf8') || '{}') as IDataObject,
  }) as unknown as IWebhookFunctions & FakeContext;
}
