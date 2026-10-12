import { main } from './cli.js';

const argv = process.argv.slice(2);
const ac = new AbortController();
// Only reencrypt can stop early (it checks the signal between batches); for
// every other command Ctrl-C keeps its default behaviour.
if (argv[0] === 'reencrypt') {
  process.once('SIGINT', () => {
    process.stderr.write('stopping after the current batch...\n');
    ac.abort();
  });
}
process.exitCode = await main(
  argv,
  process.env,
  {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
  },
  ac.signal,
);
