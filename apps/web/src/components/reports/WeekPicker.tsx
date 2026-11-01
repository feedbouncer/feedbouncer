const LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** A plain GET form, so picking a week works without script and keeps a shareable URL. */
export function WeekPicker(props: { orgId: string; current: string; weeks: string[] }) {
  // YYYY-MM-DD keys sort by date as strings.
  const weeks = [...new Set([props.current, ...props.weeks])].sort().reverse();
  return (
    <form action={`/orgs/${props.orgId}/reports`} method="get" className="flex items-end gap-2">
      <label className="flex flex-col gap-(--fb-field-gap)">
        <span className="sr-only">Week</span>
        <select name="week" defaultValue={props.current}>
          {weeks.map((w) => (
            <option key={w} value={w}>
              {`Week of ${LABEL.format(new Date(`${w}T00:00:00Z`))}`}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn-primary">
        Show
      </button>
    </form>
  );
}
