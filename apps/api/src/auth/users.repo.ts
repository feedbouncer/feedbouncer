import type pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT id, email, display_name AS name, email_verified AS "emailVerified" FROM app_user WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Emails are stored lowercase (app_user_email_lower_check); pass a normalized email. */
export async function findUserIdByEmail(db: Queryable, email: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [
    email,
  ]);
  return rows[0]?.id ?? null;
}
