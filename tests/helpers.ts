import pg from 'pg';
import { Database, type SessionContext } from '../src/db/session';

export const OWNER_URL =
  process.env.DATABASE_URL_OWNER ?? 'postgres://postgres:postgres@localhost:5432/lotline';
/** Everything a request does goes through this role: NOBYPASSRLS, no DELETE. */
export const APP_URL =
  process.env.DATABASE_URL_APP ??
  'postgres://lotline_app:lotline_app_dev@localhost:5432/lotline';
export const READONLY_URL =
  process.env.DATABASE_URL_READONLY ??
  'postgres://lotline_readonly:lotline_ro_dev@localhost:5432/lotline';

export const appDb = new Database(APP_URL);

/** Owner connection, for arranging fixtures and asserting from outside RLS. */
export async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Resolve a seeded user's id by email. */
export async function userId(email: string): Promise<string> {
  const row = await asOwner(async (c) => {
    const r = await c.query('SELECT id FROM user_account WHERE email = $1', [email]);
    if (r.rowCount === 0) throw new Error(`No seeded user ${email}`);
    return r.rows[0];
  });
  return row.id as string;
}

export async function projectId(): Promise<string> {
  const row = await asOwner(async (c) => {
    const r = await c.query(`SELECT id FROM project WHERE code = 'MRU2'`);
    return r.rows[0];
  });
  return row.id as string;
}

/** Run a query as a given user through the app role, with RLS in force. */
export async function as<T extends pg.QueryResultRow = pg.QueryResultRow>(
  email: string,
  sql: string,
  params: readonly unknown[] = [],
  extra: Partial<SessionContext> = {},
): Promise<T[]> {
  const uid = await userId(email);
  return appDb.withSession({ userId: uid, ...extra }, async (db) => {
    const r = await db.query<T>(sql, params);
    return r.rows;
  });
}

/** Count rows visible to a user. */
export async function countAs(email: string, table: string, where = 'true'): Promise<number> {
  const rows = await as<{ n: string }>(email, `SELECT count(*)::text n FROM ${table} WHERE ${where}`);
  return Number(rows[0]?.n ?? '0');
}

export const USERS = {
  qm:       'p.nandakumar@northboundcivil.com.au',
  em:       'd.whitcombe@northboundcivil.com.au',
  peA:      'j.okafor@northboundcivil.com.au',
  cadetA:   'r.silvestri@northboundcivil.com.au',
  peB:      'm.tuiletufuga@kellerman.com.au',
  foreman:  'b.arkwright@kellerman.com.au',
  gqm:      'a.delacroix@northboundcivil.com.au',
  sr:       'k.ferreira@ardentsuper.com.au',
  iv:       's.brenninkmeyer@meridianiv.com.au',
  subEarth: 't.vellacott@vellacott.com.au',
  subDrain: 'h.rowe@rowedrainage.com.au',
  supplier: 'g.pantelis@hawkesburypremix.com.au',
} as const;
