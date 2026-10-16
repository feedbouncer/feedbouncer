import { describe, expect, it } from 'vitest';
import { renderTemplate, sanitizeValue, validateTemplate, worstCaseLength } from './templates.js';

describe('renderTemplate', () => {
  it('renders variables and inline fallbacks', () => {
    expect(
      renderTemplate('Hi {{author_first_name}}, thanks from {{brand_name}}!', {
        author_name: 'Dana Levi',
        brand_name: 'Acme',
      }),
    ).toBe('Hi Dana, thanks from Acme!');
    expect(renderTemplate('Hi {{ author_first_name | friend }}!', { author_name: null })).toBe(
      'Hi friend!',
    );
    expect(renderTemplate('Hi {{author_name}}!', {})).toBe('Hi there!');
  });

  it('drops link- and mention-like values', () => {
    for (const bad of [
      'win at free-gifts.io',
      'DM @scam_support',
      'http://x',
      'www.evil',
      '#promo',
      'shop.example.com',
    ]) {
      expect(renderTemplate('Hi {{author_name}}', { author_name: bad })).toBe('Hi there');
    }
  });

  it('never re-expands tokens injected through values', () => {
    expect(renderTemplate('Hi {{author_name}}', { author_name: '{{brand_name}}' })).toBe(
      'Hi there',
    );
    expect(
      renderTemplate('{{author_name}} {{brand_name}}', {
        author_name: 'Dana',
        brand_name: '$& $1 $`',
      }),
    ).toBe('Dana $& $1 $`');
  });

  it('strips control and invisible characters and caps length', () => {
    expect(renderTemplate('{{author_name}}', { author_name: 'A‮b​c\n d' })).toBe('Abc d');
    expect([...renderTemplate('{{author_name}}', { author_name: 'x'.repeat(80) })].length).toBe(50);
  });

  it('uses the first word of the sanitized name as first name, capped at 30', () => {
    expect(renderTemplate('{{author_first_name}}', { author_name: '  ​Dana   Levi' })).toBe('Dana');
    expect(
      [...renderTemplate('{{author_first_name}}', { author_name: 'y'.repeat(45) })].length,
    ).toBe(30);
  });

  it('uses the variable default when the inline fallback is absent', () => {
    expect(renderTemplate('{{brand_name}}|{{platform}}', {})).toBe('|');
  });
});

describe('sanitizeValue', () => {
  it.each([
    ['fullwidth at sign', '＠scam'],
    ['fullwidth hash', '＃promo'],
    ['small commercial at', '﹫scam'],
    ['fullwidth braces', '｛｛x｝｝'],
    ['fullwidth domain', 'evil．com'],
    ['ideographic full stop', 'evil。com'],
    ['halfwidth ideographic full stop', 'evil｡com'],
    ['one dot leader', 'evil․com'],
    ['zero-width split domain', 'evil.​com'],
    ['bidi-wrapped domain', 'evil‮.com‬'],
    ['soft hyphen split scheme', 'ht\u00ADtp://x'],
    ['fullwidth colon scheme', 'HTTPS：//x'],
    ['hangul filler split domain', 'evil.ㅤcom'],
    ['combining grapheme joiner split', 'evil.͏com'],
    ['variation selector split', 'evil.️com'],
  ])('rejects %s', (_label, raw) => {
    expect(sanitizeValue(raw, 50)).toBeNull();
  });

  it('returns null for empty or invisible-only input', () => {
    expect(sanitizeValue(null, 10)).toBeNull();
    expect(sanitizeValue(undefined, 10)).toBeNull();
    expect(sanitizeValue(' ​‮\n ', 10)).toBeNull();
  });

  it('applies NFKC and keeps ordinary names', () => {
    expect(sanitizeValue('Ｄａｎａ', 50)).toBe('Dana');
    expect(sanitizeValue('Zo\u00EB M\u00FCller', 50)).toBe('Zo\u00EB M\u00FCller');
    expect(sanitizeValue('Dr. Smith', 50)).toBe('Dr. Smith');
  });

  it('strips joiners, so ZWJ emoji sequences degrade to their parts', () => {
    expect(sanitizeValue('👨‍👩', 10)).toBe('👨👩');
  });

  it('truncates by grapheme without splitting clusters', () => {
    expect(sanitizeValue('👍🏽👍🏽', 2)).toBe('👍🏽');
    expect(sanitizeValue('q\u0301q\u0301', 2)).toBe('q\u0301');
  });
});

describe('validateTemplate', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['Hi {{nme}}', 'unknown_variable'],
    ['Hi {{author_name', 'malformed_token'],
    ['Hi }} there', 'malformed_token'],
    ['{{author_name|a{b}}', 'malformed_token'],
    ['x'.repeat(2001), 'too_long'],
    [Array(21).fill('{{platform}}').join(' '), 'too_many_tokens'],
  ])('validateTemplate(%j) -> %s', (t, code) => {
    expect(validateTemplate(t)).toMatchObject({ ok: false, code });
  });

  it('reports the index of the offending token', () => {
    expect(validateTemplate('Hi {{nme}}')).toEqual({
      ok: false,
      code: 'unknown_variable',
      index: 3,
    });
  });

  it('accepts valid templates and counts length in code points', () => {
    expect(validateTemplate('Hi {{ author_name | friend }}!')).toEqual({ ok: true });
    expect(validateTemplate('😀'.repeat(2000))).toEqual({ ok: true });
    expect(validateTemplate(Array(20).fill('{{platform}}').join(' '))).toEqual({ ok: true });
  });
});

describe('worstCaseLength', () => {
  it('counts every variable at its max', () => {
    expect(worstCaseLength('Hi {{author_name}}!')).toBe(3 + 50 + 1);
  });

  it('uses the inline fallback when it is longer than the max', () => {
    expect(worstCaseLength(`{{platform|${'z'.repeat(40)}}}`)).toBe(40);
  });
});

describe('hardened author-name check', () => {
  it.each([
    ['combining mark before dot', 'evil̲.com'],
    ['devanagari with dot', 'कि.com'],
    ['TLD containing marks', 'evil.कॉम'],
    ['ip address', '192.168.0.1'],
    ['ftp scheme', 'ftp://x/y'],
    ['mailto', 'mailto:a'],
    ['javascript', 'javascript:x'],
    ['tel', 'tel:+1555'],
    ['arabic full stop', 'evil۔com'],
    ['devanagari danda', 'evil।com'],
    ['small full stop', 'evil﹒com'],
    ['backslash', 'evil\\com'],
    ['slash', 'a/b'],
    ['initials glued', 'J.Smith'],
  ])('rejects %s', (_l, raw) => {
    expect(sanitizeValue(raw, 50)).toBeNull();
  });

  it('keeps ordinary names, including non-Latin ones', () => {
    expect(sanitizeValue("Dana O'Brien-Smith", 50)).toBe("Dana O'Brien-Smith");
    expect(sanitizeValue('Mary Jr.', 50)).toBe('Mary Jr.');
    expect(sanitizeValue('דנה לוי', 50)).toBe('דנה לוי');
    expect(sanitizeValue('किरण शर्मा', 50)).not.toBeNull();
    expect(sanitizeValue('山田太郎', 50)).toBe('山田太郎');
  });
});

describe('code point cap', () => {
  const hostile = [
    'a' + '́'.repeat(5000),
    '\u{1F44D}\u{1F3FD}'.repeat(100),
    'é'.repeat(200),
    'x'.repeat(500),
  ];
  it.each(hostile.map((h) => [h.length, h]))(
    'render stays within worstCaseLength (%i)',
    (_n, h) => {
      for (const t of [
        '{{author_name}}',
        'Hi {{author_first_name}}!',
        '{{brand_name}}|{{platform}}',
      ]) {
        const out = renderTemplate(t, { author_name: h, brand_name: h, platform: h });
        expect([...out].length).toBeLessThanOrEqual(worstCaseLength(t));
      }
    },
  );

  it('does not leave a dangling combining mark at the cut', () => {
    const out = sanitizeValue('q' + '\u0301'.repeat(100), 50);
    expect(out).toBe('q');
  });
});

describe('whitespace controls', () => {
  it('turns newlines and tabs into spaces so first name is correct', () => {
    expect(sanitizeValue('Dana\nLevi', 50)).toBe('Dana Levi');
    expect(sanitizeValue('Dana\tLevi', 50)).toBe('Dana Levi');
    expect(renderTemplate('{{author_first_name}}', { author_name: 'Dana\nLevi' })).toBe('Dana');
  });
});

describe('trusted values', () => {
  it('renders brand_name and platform as written, without the link filter', () => {
    expect(renderTemplate('{{brand_name}}', { brand_name: 'C#' })).toBe('C#');
    expect(renderTemplate('{{brand_name}}', { brand_name: 'Cal.com' })).toBe('Cal.com');
    expect(renderTemplate('{{brand_name}}', { brand_name: 'A‮B\nC' })).toBe('AB C');
    expect([...renderTemplate('{{brand_name}}', { brand_name: 'b'.repeat(150) })].length).toBe(100);
  });
});
