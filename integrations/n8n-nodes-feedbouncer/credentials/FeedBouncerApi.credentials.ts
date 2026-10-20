import { REQUEST_TIMEOUT_MS } from '../nodes/shared/constants';
import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

// Mirrors normalizeBaseUrl: https (http only with Allow Plain HTTP), no user info, query or fragment.
// Anything else becomes an address no request can reach, so the key is never sent anywhere unsafe.
const TEST_BASE_URL = String.raw`={{(/^https:\/\/[^@?#\\\s]+$/.test($credentials.baseUrl.trim()) || ($credentials.allowHttp === true && /^http:\/\/[^@?#\\\s]+$/.test($credentials.baseUrl.trim()))) ? $credentials.baseUrl.trim().replace(/([^:])\/{2,}/g, "$1/").replace(/\/+$/, "").replace(/\/v1$/, "") : "invalid://address"}}`;

export class FeedBouncerApi implements ICredentialType {
  name = 'feedBouncerApi';

  displayName = 'FeedBouncer API';

  icon = { light: 'file:feedbouncer.svg', dark: 'file:feedbouncer.dark.svg' } as const;

  documentationUrl =
    'https://github.com/feedbouncer/feedbouncer/tree/main/integrations/n8n-nodes-feedbouncer#readme';

  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://feedbouncer.acme.io',
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
    {
      displayName: 'Allow Plain HTTP',
      name: 'allowHttp',
      type: 'boolean',
      default: false,
    },
    // The name matches the lint heuristic for secrets, but this is a plain on/off toggle.
    // eslint-disable-next-line @n8n/community-nodes/credential-password-field
    {
      displayName: 'Ignore SSL Issues (Insecure)',
      name: 'allowUnauthorizedCerts',
      type: 'boolean',
      default: false,
    },
    {
      displayName: 'Use an https:// address. Over plain http your API key is sent unencrypted.',
      name: 'httpNotice',
      type: 'notice',
      default: '',
      displayOptions: { show: { allowHttp: [true] } },
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: { Authorization: '=Bearer {{$credentials.apiKey}}' },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: TEST_BASE_URL,
      url: '/v1/key',
      method: 'GET',
      disableFollowRedirect: true,
      timeout: REQUEST_TIMEOUT_MS,
      skipSslCertificateValidation: '={{$credentials.allowUnauthorizedCerts}}',
    },
    rules: [
      {
        type: 'responseCode',
        properties: {
          value: 401,
          message:
            'FeedBouncer rejected this API key. It may be revoked or mistyped. Create a new key in FeedBouncer under Settings → API keys.',
        },
      },
      {
        type: 'responseCode',
        properties: {
          value: 404,
          message:
            'No FeedBouncer API found at this address, or the server is older than this node supports. Check the address (the one you sign in at).',
        },
      },
    ],
  };
}
