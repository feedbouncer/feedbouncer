'use client';
import { useId, useState, type FormEvent } from 'react';
import type { TagOption } from '../../lib/org-comments';
import { tagNameError } from '../../lib/triage';

/** A comment's tags: remove one, add an existing one, or create a new one. Names are text nodes. */
export function TagPicker({
  tags,
  applied,
  busy,
  onAdd,
  onRemove,
  onCreate,
}: {
  /** Every tag of the workspace. */
  tags: TagOption[];
  applied: TagOption[];
  busy: boolean;
  onAdd: (tagId: string) => void;
  onRemove: (tagId: string) => void;
  onCreate: (name: string) => void;
}) {
  const id = useId();
  const has = new Set(applied.map((t) => t.id));
  const addable = tags.filter((t) => !has.has(t.id));
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const chosen = addable.some((t) => t.id === pick) ? pick : (addable[0]?.id ?? '');
  const nameId = `${id}-name`;
  const errorId = `${id}-error`;

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const error = tagNameError(name);
    setNameError(error);
    if (error) return;
    onCreate(name.trim());
    setName('');
  }

  return (
    <div>
      Tags:{' '}
      {applied.length > 0 ? (
        <ul aria-label="Tags">
          {applied.map((t) => (
            <li key={t.id}>
              {t.name}{' '}
              <button
                type="button"
                aria-label={`Remove tag ${t.name}`}
                disabled={busy}
                onClick={() => onRemove(t.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        'None '
      )}
      {addable.length > 0 ? (
        <>
          <select
            aria-label="Tag to add"
            value={chosen}
            disabled={busy}
            onChange={(e) => setPick(e.target.value)}
          >
            {addable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>{' '}
          <button type="button" disabled={busy || !chosen} onClick={() => onAdd(chosen)}>
            Add tag
          </button>{' '}
        </>
      ) : null}
      <form onSubmit={create}>
        <label htmlFor={nameId}>New tag</label>{' '}
        <input
          id={nameId}
          dir="auto"
          value={name}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? errorId : undefined}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(tagNameError(e.target.value));
          }}
        />{' '}
        <button type="submit" disabled={busy}>
          Create
        </button>
        {nameError ? (
          <small id={errorId} role="alert">
            {' '}
            {nameError}
          </small>
        ) : null}
      </form>
    </div>
  );
}
