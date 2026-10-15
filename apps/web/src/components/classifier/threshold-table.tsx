'use client';
import { useState } from 'react';
import {
  CATEGORY_LABEL,
  buildThresholdUpdate,
  editOf,
  type Category,
  type ThresholdEdit,
  type ThresholdItem,
  type ThresholdView,
} from '../../lib/classifier';
import { formatUtc } from '../../lib/format';
import { ACTION_LABEL, RULE_ACTIONS, type RuleAction } from '../../lib/rules';

type Edits = Record<Category, ThresholdEdit>;

export function ThresholdTable(props: {
  categories: ThresholdView[];
  canEdit: boolean;
  onSave: (items: ThresholdItem[]) => Promise<void> | void;
  onPreview?: ((items: ThresholdItem[]) => Promise<void> | void) | undefined;
}) {
  const [edits, setEdits] = useState<Edits>(
    () => Object.fromEntries(props.categories.map((c) => [c.category, editOf(c)])) as Edits,
  );
  const [errors, setErrors] = useState<Partial<Record<Category, string>>>({});
  const [busy, setBusy] = useState(false);
  const change = (category: Category, patch: Partial<ThresholdEdit>) =>
    setEdits((prev) => ({ ...prev, [category]: { ...prev[category], ...patch } }));

  async function submit(action: (items: ThresholdItem[]) => Promise<void> | void) {
    const { items, errors: found } = buildThresholdUpdate(props.categories, edits);
    setErrors(found);
    if (Object.keys(found).length > 0 || items.length === 0) return;
    setBusy(true);
    try {
      await action(items);
    } finally {
      setBusy(false);
    }
  }

  const deleting = props.categories.some(
    (c) => !edits[c.category]?.useDefault && edits[c.category]?.action === 'remove',
  );
  return (
    <div>
      <table>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Threshold</th>
            <th scope="col">Action</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {props.categories.map((c) => {
            const label = CATEGORY_LABEL[c.category];
            const e = edits[c.category] ?? editOf(c);
            const error = errors[c.category];
            return (
              <tr key={c.category}>
                <th scope="row">{label}</th>
                <td>
                  {props.canEdit ? (
                    <>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        aria-label={`${label} threshold`}
                        aria-invalid={error ? true : undefined}
                        value={e.threshold}
                        disabled={e.useDefault}
                        onChange={(ev) => change(c.category, { threshold: ev.target.value })}
                      />
                      {error ? <p role="alert">{error}</p> : null}
                    </>
                  ) : (
                    c.threshold.toFixed(2)
                  )}
                </td>
                <td>
                  {props.canEdit ? (
                    <select
                      aria-label={`${label} action`}
                      value={e.action}
                      disabled={e.useDefault}
                      onChange={(ev) =>
                        change(c.category, { action: ev.target.value as RuleAction })
                      }
                    >
                      {RULE_ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {ACTION_LABEL[a]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    ACTION_LABEL[c.action]
                  )}
                </td>
                <td>
                  {c.source === 'default' ? 'Default' : 'Customized'}
                  {c.updatedBy || c.updatedAt
                    ? ` (changed${c.updatedBy ? ` by ${c.updatedBy.name ?? 'a former member'}` : ''}${c.updatedAt ? ` ${formatUtc(c.updatedAt)}` : ''})`
                    : null}
                  {props.canEdit && c.source === 'brand' ? (
                    <>
                      {' '}
                      <label>
                        <input
                          type="checkbox"
                          checked={e.useDefault}
                          onChange={(ev) => change(c.category, { useDefault: ev.target.checked })}
                        />{' '}
                        Use default
                      </label>
                    </>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {deleting ? (
        <p role="note">Delete cannot be undone: deleted comments are removed from the platform.</p>
      ) : null}
      {props.canEdit ? (
        <p>
          <button type="button" disabled={busy} onClick={() => void submit(props.onSave)}>
            Save thresholds
          </button>
          {props.onPreview ? (
            <>
              {' '}
              <button type="button" disabled={busy} onClick={() => void submit(props.onPreview!)}>
                Preview
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
