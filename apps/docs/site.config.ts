export const SITE_URL = 'https://feedbouncer.github.io';
export const BASE_URL = '/feedbouncer/';
export const REPO = 'feedbouncer/feedbouncer';

/** The only hosts an external link in the docs may point to. */
export const ALLOWED_LINK_HOSTS = [
  'github.com',
  'developers.facebook.com',
  'modelcontextprotocol.io',
  'code.claude.com',
  'claude.ai',
  'cursor.com',
  'code.visualstudio.com',
  'nodejs.org',
  'pnpm.io',
  'feedbouncer.example.com',
] as const;

export const SUPPORTED_MCP_CLIENTS = ['claude-desktop', 'claude-code', 'cursor', 'vscode'] as const;
