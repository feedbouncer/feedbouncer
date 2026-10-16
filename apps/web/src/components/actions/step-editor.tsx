'use client';
import { useId } from 'react';
import {
  CONFIRM_LABEL,
  REVERSIBILITY_LABEL,
  STEP_LABEL,
  STEP_ORDER,
  TEMPLATE_HELP,
  TEMPLATE_SYNTAX_HELP,
  conflictReason,
  isConfirmed,
  setConfirmed,
  setTemplate,
  stepAvailability,
  stepIssues,
  templateCount,
  toggleStep,
  type ActionCapabilitiesDto,
  type DraftStep,
} from '../../lib/actions';

type ReplyType = 'auto_reply' | 'private_reply';

function Template(props: {
  type: ReplyType;
  value: string;
  max: number | null;
  onChange: (template: string) => void;
}) {
  const id = useId();
  const { count, max, over } = templateCount(props.value, props.max);
  return (
    <div>
      <textarea
        name={`template-${props.type}`}
        aria-label={`${STEP_LABEL[props.type]} text`}
        aria-describedby={id}
        aria-invalid={over || undefined}
        rows={4}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <small id={id}>
        {max === null ? `${count}` : `${count} / ${max}`}
        {over ? ' Too long for this platform.' : ''}
      </small>
    </div>
  );
}

export function StepEditor(props: {
  value: DraftStep[];
  onChange: (value: DraftStep[]) => void;
  capabilities: ActionCapabilitiesDto;
  onlyPlatform?: string;
  /** Problems the API reported for the rule; those at actions.<n> show under step n. */
  issues?: { path: string; message: string }[];
}) {
  const id = useId();
  const availability = stepAvailability(props.capabilities, props.onlyPlatform);
  // A chosen step stays listed even when it is no longer supported, so it can be unticked.
  const shown = STEP_ORDER.filter(
    (t) => availability[t].available || props.value.some((s) => s.type === t),
  );
  const hasReply = props.value.some((s) => s.type === 'auto_reply' || s.type === 'private_reply');
  return (
    <fieldset>
      <legend>When it matches</legend>
      {props.value.length === 0 ? (
        <p role="note">No steps: matching comments are allowed.</p>
      ) : null}
      {shown.map((type) => {
        const step = props.value.find((s) => s.type === type);
        const index = step ? props.value.indexOf(step) : -1;
        const conflict = step ? null : conflictReason(type, props.value);
        const a = availability[type];
        const noteId = `${id}-${type}`;
        const problems = step ? stepIssues(props.issues ?? [], index) : [];
        return (
          <div key={type} style={{ marginBottom: 12 }}>
            <label style={{ display: 'block' }}>
              <input
                type="checkbox"
                name={`step-${type}`}
                checked={step !== undefined}
                disabled={conflict !== null}
                aria-describedby={conflict ? noteId : undefined}
                onChange={(e) => props.onChange(toggleStep(props.value, type, e.target.checked))}
              />{' '}
              {STEP_LABEL[type]} <small>({REVERSIBILITY_LABEL[type]})</small>
            </label>
            {step && (step.type === 'delete' || step.type === 'ban') ? (
              // Its own box, unticked when the step is chosen: required before the form submits.
              <label style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  name={`confirm-${step.type}`}
                  required
                  checked={isConfirmed(step)}
                  onChange={(e) =>
                    props.onChange(setConfirmed(props.value, step.type, e.target.checked))
                  }
                />{' '}
                {CONFIRM_LABEL[step.type]}
              </label>
            ) : null}
            {a.unavailableOn.length > 0 ? (
              <small>{` Not available on ${a.unavailableOn.join(', ')}`}</small>
            ) : null}
            {a.missingPermissionOn.length > 0 ? (
              <small role="note">
                {` Needs a permission on ${a.missingPermissionOn.join(', ')}: reconnect the account and allow it, or this step fails there.`}
              </small>
            ) : null}
            {conflict ? <small id={noteId}>{` ${conflict}`}</small> : null}
            {step?.type === 'auto_reply' || step?.type === 'private_reply' ? (
              <Template
                type={step.type}
                value={step.template}
                max={a.maxChars}
                onChange={(t) => props.onChange(setTemplate(props.value, step.type, t))}
              />
            ) : null}
            {problems.length > 0 ? (
              <ul role="alert">
                {problems.map((m, n) => (
                  <li key={n}>{m}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
      {hasReply ? (
        <div>
          <p>
            <small>{TEMPLATE_SYNTAX_HELP}</small>
          </p>
          <ul>
            {TEMPLATE_HELP.map((v) => (
              <li key={v.token}>
                <code>{v.token}</code> {v.help}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </fieldset>
  );
}
