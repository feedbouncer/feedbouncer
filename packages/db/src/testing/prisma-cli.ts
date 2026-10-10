import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRISMA = path.join(PACKAGE_ROOT, 'node_modules/.bin/prisma');

export function runPrisma(args: string[], url: URL, opts: { migrationsDir?: string } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: url.href,
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    };
    if (opts.migrationsDir) env.FB_MIGRATIONS_DIR = opts.migrationsDir;
    else delete env.FB_MIGRATIONS_DIR;
    const secrets = [url.href, url.password, decodeURIComponent(url.password)].filter(Boolean);
    const redact = (text: string) =>
      secrets.reduce((acc, secret) => acc.replaceAll(secret, '[redacted]'), text);
    execFile(PRISMA, args, { cwd: PACKAGE_ROOT, env, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });
}
