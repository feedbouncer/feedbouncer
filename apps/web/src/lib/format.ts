// Fixed UTC rendering, so server and browser output agree.
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
