import { text } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { jsonArrayStream } from './json-array-stream.js';

async function* from<T>(rows: T[]): AsyncIterable<T> {
  for (const r of rows) yield r;
}

describe('jsonArrayStream', () => {
  it('writes an empty array for no rows', async () => {
    const out = await text(jsonArrayStream(from([])));
    expect(out).toBe('[\n\n]\n');
    expect(JSON.parse(out)).toEqual([]);
  });

  it('writes one row per line, separated by commas', async () => {
    const rows = [{ a: 1 }, { b: 'two', c: null }, { d: [3, { e: true }] }];
    const out = await text(jsonArrayStream(from(rows)));
    expect(out).toBe('[\n{"a":1},\n{"b":"two","c":null},\n{"d":[3,{"e":true}]}\n]\n');
    expect(JSON.parse(out)).toEqual(rows);
  });

  it('round-trips line separators, quotes and emoji as UTF-8', async () => {
    const rows = [{ body: 'line sep para "quoted" \\ 🎉 שלום' }];
    const stream = jsonArrayStream(from(rows));
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(rows);
  });

  it('fails the stream when the rows fail', async () => {
    async function* broken(): AsyncIterable<object> {
      yield { a: 1 };
      throw new Error('query failed');
    }
    await expect(text(jsonArrayStream(broken()))).rejects.toThrow('query failed');
  });
});
