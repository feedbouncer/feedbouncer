import { join, resolve } from 'node:path';

// Playwright loads this file as CommonJS, so it cannot use import.meta like content.ts does.
const appRoot = resolve(__dirname, '../..');

export const GROUPS = ['Now', 'Next', 'Later', 'Shipped'] as const;
export type Group = (typeof GROUPS)[number];

export const DISCLAIMER = 'This shows intent, not a commitment.';
export const EMPTY_GROUP = 'Nothing here yet.';
export const ROADMAP_FILE = join(appRoot, 'src/pages/roadmap.md');

export type RoadmapItem = { group: Group; title: string; description: string };

const ITEM = /^- \*\*(.+?)\*\*: (.+\.)$/;

export function parseRoadmap(md: string): {
  h1: string[];
  h2: string[];
  disclaimer: string;
  lastUpdated: string;
  groups: Record<Group, { items: RoadmapItem[]; empty: boolean }>;
} {
  const text = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines = text.split('\n');
  const headings = (marker: '#' | '##') =>
    lines.flatMap((l) => {
      const match = new RegExp(`^${marker} (.+?)\\s*$`).exec(l);
      return match ? [match[1]!] : [];
    });
  const h1 = headings('#');
  const h2 = headings('##');

  const h1Index = lines.findIndex((l) => /^# /.test(l));
  const disclaimer = lines.slice(h1Index + 1).find((l) => l.trim() !== '') ?? '';

  const firstH2 = text.search(/^## /m);
  const head = firstH2 === -1 ? text : text.slice(0, firstH2);
  const lastUpdated = /^\*\*Last updated:\*\* (\d{4}-\d{2}-\d{2})$/m.exec(head)?.[1];
  if (!lastUpdated) throw new Error('missing Last updated');

  const groups = {} as Record<Group, { items: RoadmapItem[]; empty: boolean }>;
  for (const group of GROUPS) {
    const start = lines.findIndex((l) => l === `## ${group}`);
    if (start === -1) throw new Error(`${group}: missing section`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^## /.test(l));
    const sectionLines = end === -1 ? rest : rest.slice(0, end);
    const items: RoadmapItem[] = [];
    let empty = false;
    for (const line of sectionLines) {
      if (line.startsWith('- ')) {
        const m = ITEM.exec(line);
        if (!m) throw new Error(`${group}: malformed item: ${line}`);
        items.push({ group, title: m[1]!, description: m[2]! });
      } else if (line === EMPTY_GROUP) {
        empty = true;
      }
    }
    const hasItems = items.length > 0;
    if (hasItems === empty) {
      throw new Error(`${group}: expected items or "${EMPTY_GROUP}"`);
    }
    groups[group] = { items, empty };
  }
  return { h1, h2, disclaimer, lastUpdated, groups };
}
