import type { NextConfig } from 'next';

// Docker Desktop bind mounts often drop file events, so `next dev` never sees
// edits. WEB_WATCH_POLL_MS > 0 makes Next's (Turbopack) watcher poll instead.
const pollMs = Number(process.env.WEB_WATCH_POLL_MS ?? 0);
// Server-side only: where the browser-facing /api/* paths are proxied to.
const apiOrigin = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  async rewrites() {
    return [
      { source: '/api/auth/:path*', destination: `${apiOrigin}/api/auth/:path*` },
      { source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Invite and reset tokens live in URLs, so never send them as a referrer.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          },
        ],
      },
    ];
  },
  ...(Number.isFinite(pollMs) && pollMs > 0 ? { watchOptions: { pollIntervalMs: pollMs } } : {}),
};

export default config;
