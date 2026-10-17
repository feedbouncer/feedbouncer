'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { messageFor } from '../lib/messages';

export interface Field {
  name: string;
  label: string;
  type: 'text' | 'email' | 'password' | 'select';
  options?: readonly (string | { value: string; label: string })[];
  autoComplete?: string;
  defaultValue?: string;
}

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text?: string | undefined };

export function ApiForm(props: {
  action: `/api/${string}`;
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  fields: Field[];
  submitLabel: string;
  /** Values sent with the fields; a function is called on submit (for browser-only values). */
  extraBody?: Record<string, unknown> | (() => Record<string, unknown>);
  successMessage?: string | ((body: unknown) => string);
  redirectTo?: string;
  refresh?: boolean;
  /** Clear the inputs after a successful submit (for secrets such as webhook URLs). */
  resetOnSuccess?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: 'busy' });
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const extra = props.extraBody;
    const body: Record<string, unknown> = { ...(typeof extra === 'function' ? extra() : extra) };
    for (const f of props.fields) body[f.name] = String(form.get(f.name) ?? '');
    try {
      const res = await apiFetch<unknown>(props.action, { method: props.method ?? 'POST', body });
      const msg = props.successMessage;
      setStatus({ kind: 'ok', text: typeof msg === 'function' ? msg(res) : msg });
      if (props.resetOnSuccess) formEl.reset();
      if (props.redirectTo) router.push(props.redirectTo);
      else if (props.refresh) router.refresh();
    } catch (err) {
      setStatus({
        kind: 'error',
        text: err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.',
      });
    }
  }

  return (
    <form onSubmit={onSubmit}>
      {props.fields.map((f) => (
        <label key={f.name} style={{ display: 'block', marginBottom: 8 }}>
          {f.label}{' '}
          {f.type === 'select' ? (
            <select name={f.name} defaultValue={f.defaultValue}>
              {(f.options ?? []).map((o) => {
                const opt = typeof o === 'string' ? { value: o, label: o } : o;
                return (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                );
              })}
            </select>
          ) : (
            <input
              name={f.name}
              type={f.type}
              autoComplete={f.autoComplete}
              defaultValue={f.defaultValue}
              required
            />
          )}
        </label>
      ))}
      <button type="submit" disabled={status.kind === 'busy'}>
        {props.submitLabel}
      </button>
      {status.text ? (
        <p role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p>
      ) : null}
    </form>
  );
}
