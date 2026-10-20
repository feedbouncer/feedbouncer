import { Readable } from 'node:stream';

async function* chunks(rows: AsyncIterable<unknown>): AsyncIterable<string> {
  yield '[\n';
  let separator = '';
  for await (const row of rows) {
    yield separator + JSON.stringify(row);
    separator = ',\n';
  }
  yield '\n]\n';
}

/**
 * A UTF-8 JSON array, one row per line. Rows are pulled from `rows` only as the stream is
 * read; a failing source fails the stream.
 */
export function jsonArrayStream<T>(rows: AsyncIterable<T>): Readable {
  return Readable.from(chunks(rows), { objectMode: false });
}
