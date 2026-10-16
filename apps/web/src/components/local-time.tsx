'use client';
import { Fragment, useEffect, useState } from 'react';
import { formatUtc } from '../lib/format';
import { formatLocal } from '../lib/review-mode';

/** UTC on the server and the first client render (so hydration matches), then the viewer's zone. */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => formatUtc(iso));
  useEffect(() => setText(formatLocal(iso)), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

// Marks where a time goes in built copy, so each sentence stays in one place.
const MARK = '\u0000';

/** Copy built with a time formatter, each time rendered as a LocalTime. */
export function TextWithTimes({ build }: { build: (fmt: (iso: string) => string) => string }) {
  return build((iso) => `${MARK}${iso}${MARK}`)
    .split(MARK)
    .map((part, i) => <Fragment key={i}>{i % 2 === 1 ? <LocalTime iso={part} /> : part}</Fragment>);
}
