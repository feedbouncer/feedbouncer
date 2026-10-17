// Control characters and bidi embeddings/overrides/isolates.
const UNSAFE = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;
const URLS = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const MAX_CODE_POINTS = 140;

export function excerpt(body: string): string {
  const s = body.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(URLS, '[link]');
  const cps = Array.from(s);
  return cps.length > MAX_CODE_POINTS ? `${cps.slice(0, MAX_CODE_POINTS).join('').trimEnd()}…` : s;
}

export function slackEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(here|channel|everyone)/gi, '@​$1');
}
