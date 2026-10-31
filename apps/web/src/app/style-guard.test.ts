import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { walk } from '../test/walk';

const files = walk('src', ['.tsx'])
  .map((f) => f.replaceAll('\\', '/'))
  .filter((f) => !f.startsWith('src/components/ui/'));
const read = (f: string) => readFileSync(f, 'utf8');

/** Files (with line numbers) whose lines satisfy `bad`. */
function offenders(bad: (line: string, lines: string[], i: number, file: string) => boolean) {
  return files.flatMap((file) => {
    const lines = read(file).split('\n');
    return lines.flatMap((line, i) => (bad(line, lines, i, file) ? [`${file}:${i + 1}`] : []));
  });
}

describe('style guard', () => {
  it('(a) has no colour literals in JSX or anywhere outside layout.tsx', () => {
    expect(offenders((l) => /(style|className)=[^>]*#[0-9a-fA-F]{3,8}\b/.test(l))).toEqual([]);
    expect(
      offenders((l, _ls, _i, f) => f !== 'src/app/layout.tsx' && /#[0-9a-fA-F]{3,8}\b/.test(l)),
    ).toEqual([]);
  });

  it('(b) has no inline style={ outside comment-body.tsx', () => {
    // comment-body.tsx is allowlisted: comment-body.test.tsx asserts its inline style.
    expect(
      offenders((l, _ls, _i, f) => f !== 'src/components/comment-body.tsx' && /\bstyle=\{/.test(l)),
    ).toEqual([]);
  });

  it('(c) wraps every table in TableScroll', () => {
    const bad = files.filter(
      (f) => read(f).includes('<table') && !read(f).includes('<TableScroll'),
    );
    expect(bad).toEqual([]);
  });

  it('(d) has no arbitrary raw values', () => {
    const re =
      /(rounded|text|font|max-w|duration|ease|shadow|p[xytrbl]?|m[xytrbl]?|gap)-\[[^\]]*\d(px|ms|rem)/;
    expect(offenders((l) => re.test(l) || /(?:scale|blur)-\[/.test(l))).toEqual([]);
  });

  it('(e) uses logical, not physical, direction utilities', () => {
    expect(offenders((l) => /\b(pl|pr|ml|mr|left|right)-\d|text-(left|right)\b/.test(l))).toEqual(
      [],
    );
  });

  it('(f) prefixes translate/scale utilities with motion-safe:', () => {
    const re = /(?<![\w-])((?:[a-z-]+:)*)-?(?:translate|scale)(?:-[xyz])?-[\w.[\]/-]+/g;
    const bad = offenders((l) =>
      [...l.matchAll(re)].some(
        (m) => !/^(?:(?:hover|active):)*motion-safe:(?:(?:hover|active):)*$/.test(m[1] ?? ''),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('(g) marks every empty message with data-state="empty"', () => {
    const allow = ['No changes to save.', 'No steps:'];
    const bad = offenders((line, lines, i) => {
      if (!/(>|^)\s*(No |Nothing )\S|\{NONE_\w+\}/.test(line)) return false;
      if (allow.some((a) => line.includes(a))) return false;
      const near = [line, lines[i - 1] ?? ''];
      return !near.some((l) => l.includes('data-state="empty"'));
    });
    expect(bad).toEqual([]);
  });
});
