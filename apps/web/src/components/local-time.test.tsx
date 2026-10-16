import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { formatLocal } from '../lib/review-mode';
import { LocalTime } from './local-time';

const effects: (() => void)[] = [];
const updates: unknown[] = [];

// Server rendering never runs effects, so record them and the state they set.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useEffect: (fn: () => void) => void effects.push(fn),
    useState: <T,>(init: T | (() => T)) => [
      typeof init === 'function' ? (init as () => T)() : init,
      (v: unknown) => void updates.push(v),
    ],
  };
});

describe('LocalTime', () => {
  it('renders UTC first, then local after effect', () => {
    const iso = '2026-10-27T10:00:00.000Z';
    expect(renderToStaticMarkup(<LocalTime iso={iso} />)).toBe(
      `<time dateTime="${iso}">2026-10-27 10:00 UTC</time>`,
    );
    expect(updates).toEqual([]);
    for (const fn of effects) fn();
    expect(updates).toEqual([formatLocal(iso)]);
  });

  it('renders markup in the time as text', () => {
    const html = renderToStaticMarkup(<LocalTime iso={'<b>x</b>'} />);
    expect(html).not.toContain('<b>');
  });
});
