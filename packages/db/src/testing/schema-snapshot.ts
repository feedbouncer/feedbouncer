import type pg from 'pg';

const QUERIES = [
  `SELECT format('col %s.%s %s %s %s %s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
          CASE WHEN a.attnotnull THEN 'not null' ELSE 'null' END, a.attidentity,
          coalesce(pg_get_expr(d.adbin, d.adrelid), '')) AS line
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relname <> '_prisma_migrations'`,
  `SELECT format('con %s %s %s', c.relname, k.conname, pg_get_constraintdef(k.oid)) AS line
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname <> '_prisma_migrations'`,
  `SELECT format('idx %s', indexdef) AS line FROM pg_indexes
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  `SELECT format('trg %s', pg_get_triggerdef(t.oid)) AS line
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  `SELECT format('fn %s %s', p.proname, md5(pg_get_functiondef(p.oid))) AS line
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
];

export async function snapshotSchema(client: pg.ClientBase): Promise<string[]> {
  const lines: string[] = [];
  for (const q of QUERIES)
    lines.push(...(await client.query<{ line: string }>(q)).rows.map((r) => r.line));
  return lines.sort();
}
