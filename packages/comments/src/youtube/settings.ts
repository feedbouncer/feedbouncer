// Owner settings for one YouTube connection. A missing row means the defaults.
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Queryable } from './sql.js';

export const DEFAULT_DAILY_BUDGET_UNITS = 2000;

export interface YouTubeSettings {
  dailyBudgetUnits: number;
  dryRun: boolean;
  protectedAuthorIds: string[];
}

export type YouTubeSettingsPatch = {
  [K in keyof YouTubeSettings]?: YouTubeSettings[K] | undefined;
};

interface Row {
  daily_budget_units: number;
  dry_run: boolean;
  protected_author_ids: string[];
}

const toSettings = (r: Row): YouTubeSettings => ({
  dailyBudgetUnits: r.daily_budget_units,
  dryRun: r.dry_run,
  protectedAuthorIds: r.protected_author_ids,
});

const defaultYouTubeSettings = (): YouTubeSettings => ({
  dailyBudgetUnits: DEFAULT_DAILY_BUDGET_UNITS,
  dryRun: false,
  protectedAuthorIds: [],
});

const COLUMNS = 'daily_budget_units, dry_run, protected_author_ids';

export class PgYouTubeSettings {
  constructor(private readonly pool: Queryable) {}

  /** `q` lets a caller read inside its own transaction. */
  async get(scope: ConnectionScope, q: Queryable = this.pool): Promise<YouTubeSettings> {
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM youtube_connection_settings
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    );
    return rows[0] ? toSettings(rows[0]) : defaultYouTubeSettings();
  }

  /** Upserts the patched fields; `q` lets a caller write inside its own transaction. Throws when the connection is not in this scope. */
  async update(
    scope: ConnectionScope,
    patch: YouTubeSettingsPatch,
    userId: string,
    q: Queryable = this.pool,
  ): Promise<YouTubeSettings> {
    const d = defaultYouTubeSettings();
    const { rows } = await q.query<Row>(
      `INSERT INTO youtube_connection_settings AS s
         (connection_id, organization_id, brand_id, daily_budget_units, dry_run,
          protected_author_ids, updated_by_user_id)
       VALUES ($3, $1, $2, COALESCE($4::int, $8::int), COALESCE($5::boolean, $9::boolean),
               COALESCE($6::text[], $10::text[]), $7)
       ON CONFLICT (connection_id) DO UPDATE SET
         daily_budget_units = COALESCE($4::int, s.daily_budget_units),
         dry_run = COALESCE($5::boolean, s.dry_run),
         protected_author_ids = COALESCE($6::text[], s.protected_author_ids),
         updated_by_user_id = $7
       WHERE s.organization_id = $1 AND s.brand_id = $2
       RETURNING ${COLUMNS}`,
      [
        scope.organizationId,
        scope.brandId,
        scope.connectionId,
        patch.dailyBudgetUnits ?? null,
        patch.dryRun ?? null,
        patch.protectedAuthorIds ?? null,
        userId,
        d.dailyBudgetUnits,
        d.dryRun,
        d.protectedAuthorIds,
      ],
    );
    if (!rows[0]) throw new Error('youtube_settings_connection_not_found');
    return toSettings(rows[0]);
  }
}
