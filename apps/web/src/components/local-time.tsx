'use client';
import { Fragment, useEffect, useState } from 'react';
import { formatExactUtc, formatUtc } from '../lib/format';
import { formatLocal, formatLocalExact } from '../lib/review-mode';

/**
 * UTC on the server and the first client render (so hydration matches), then the viewer's zone.
 * `exactTitle` adds a tooltip with the time to the second.
 */
export function LocalTime({ iso, exactTitle = false }: { iso: string; exactTitle?: boolean }) {
  const [text, setText] = useState(() => formatUtc(iso));
  const [title, setTitle] = useState(() => formatExactUtc(iso));
  useEffect(() => {
    setText(formatLocal(iso));
    if (exactTitle) setTitle(formatLocalExact(iso));
  }, [iso, exactTitle]);
  return (
    <time dateTime={iso} title={exactTitle ? title : undefined}>
      {text}
    </time>
  );
}

// Marks where a time goes in built copy, so each sentence stays in one place.
const MARK = '\u0000';

/** Copy built with a time formatter, each time rendered as a LocalTime. */
export function TextWithTimes({ build }: { build: (fmt: (iso: string) => string) => string }) {
  return build((iso) => `${MARK}${iso}${MARK}`)
    .split(MARK)
    .map((part, i) => <Fragment key={i}>{i % 2 === 1 ? <LocalTime iso={part} /> : part}</Fragment>);
}
