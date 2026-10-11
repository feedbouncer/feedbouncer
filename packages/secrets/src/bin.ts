import { main } from './cli.js';

const ac = new AbortController();
process.once('SIGINT', () => {
  process.stderr.write('stopping after the current row...\n');
  ac.abort();
});
process.exitCode = await main(
  process.argv.slice(2),
  process.env,
  {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
  },
  ac.signal,
);
