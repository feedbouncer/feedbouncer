export const SITE_URL = 'https://feedbouncer.github.io';
export const BASE_URL = '/feedbouncer/';
export const REPO = 'feedbouncer/feedbouncer';

/** The only hosts an external link in the docs may point to. */
export const ALLOWED_LINK_HOSTS = [
  'github.com',
  'developers.facebook.com',
  'modelcontextprotocol.io',
  'cursor.com',
  'code.visualstudio.com',
  'nodejs.org',
  'pnpm.io',
  'feedbouncer.example.com',
] as const;

export const SUPPORTED_MCP_CLIENTS = ['desktop-app', 'cursor', 'vscode'] as const;

export const ROADMAP_ROUTE = '/roadmap/';
export const ROADMAP_URL = `${SITE_URL}${BASE_URL}roadmap/`;
