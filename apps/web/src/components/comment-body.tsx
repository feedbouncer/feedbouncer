'use client';
import { useState } from 'react';
import { needsCollapse } from '../lib/comment-text';

// Comment text exactly as posted, as a text node. A long body is clipped
// visually while collapsed; the full text is always in the DOM.
export function CommentBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = needsCollapse(body);
  const collapsed = collapsible && !expanded;
  return (
    <>
      <p
        dir="auto"
        className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
        style={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          ...(collapsed ? { maxHeight: '12em', overflow: 'hidden' } : {}),
        }}
      >
        {body || '(no text: sticker or attachment)'}
      </p>
      {collapsible ? (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}
