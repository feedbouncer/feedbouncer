// Compiles the TypeScript sources and copies the icons next to the compiled files.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, statSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execFileSync('tsc', { stdio: 'inherit' });
for (const dir of ['credentials', 'nodes']) {
  cpSync(dir, `dist/${dir}`, {
    recursive: true,
    filter: (source) => statSync(source).isDirectory() || /\.(svg|png)$/.test(source),
  });
}
