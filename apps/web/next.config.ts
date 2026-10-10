import type { NextConfig } from 'next';

// Docker Desktop bind mounts often drop file events, so `next dev` never sees
// edits. WEB_WATCH_POLL_MS > 0 makes Next's (Turbopack) watcher poll instead.
const pollMs = Number(process.env.WEB_WATCH_POLL_MS ?? 0);

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  ...(Number.isFinite(pollMs) && pollMs > 0 ? { watchOptions: { pollIntervalMs: pollMs } } : {}),
};

export default config;
