import type { NextConfig } from 'next';

// Docker Desktop bind mounts often drop file events, so `next dev` never sees
// edits. WEB_WATCH_POLL_MS > 0 makes Next's (Turbopack) watcher poll instead.
const pollMs = Number(process.env.WEB_WATCH_POLL_MS ?? 0);

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  // /api/auth/* and /api/v1/* are forwarded to the API by route handlers
  // (src/app/api/*/[...path]), not rewrites: see src/lib/api-proxy.ts.
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
