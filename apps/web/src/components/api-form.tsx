'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { messageFor } from '../lib/messages';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

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
  /**
   * The button's weight: `primary` for the one main action on the page or card, `secondary`
   * (the default) for an everyday settings action, `destructive` for something dangerous or
   * irreversible (archive, remove, leave, revoke).
   */
  variant?: 'primary' | 'secondary' | 'destructive';
  /**
   * `stacked` (the default) puts each field on its own line with the button below, for forms
   * with more than one field. `inline` puts a single field and its button side by side, so
   * e.g. a rename field and its submit read as one unit instead of two full-width blocks.
   */
  layout?: 'stacked' | 'inline';
  /** A compact button, for a row inside a list or table. */
  size?: 'sm' | 'default';
  /** Stretch the submit button to the form's width (only for a narrow standalone form). */
  fullWidthSubmit?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const layout = props.layout ?? 'stacked';
  const variant = props.variant ?? 'secondary';

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

  const submit = (
    <Button
      type="submit"
      variant={variant === 'primary' ? 'default' : variant}
      size={props.size ?? 'default'}
      disabled={status.kind === 'busy'}
      className={props.fullWidthSubmit ? 'w-full' : undefined}
    >
      {props.submitLabel}
    </Button>
  );

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        layout === 'inline' && props.fields.length === 1
          ? 'flex flex-col gap-(--fb-field-gap)'
          : 'flex max-w-form flex-col gap-(--fb-form-gap)',
        props.className,
      )}
    >
      {layout === 'inline' && props.fields.length === 1
        ? props.fields.map((f) => (
            <div key={f.name} className="flex flex-col gap-(--fb-field-gap)">
              <label htmlFor={f.name}>{f.label}</label>
              <div className="flex items-center gap-2">
                {f.type === 'select' ? (
                  <select
                    name={f.name}
                    id={f.name}
                    defaultValue={f.defaultValue}
                    className="flex-1"
                  >
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
                    id={f.name}
                    type={f.type}
                    autoComplete={f.autoComplete}
                    defaultValue={f.defaultValue}
                    required
                    className="flex-1"
                  />
                )}
                {submit}
              </div>
            </div>
          ))
        : props.fields.map((f) => (
            <label key={f.name} className="flex flex-col gap-(--fb-field-gap)">
              {f.label}
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
      {layout === 'inline' && props.fields.length === 1 ? null : submit}
      {status.text ? (
        <p role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p>
      ) : null}
    </form>
  );
}
