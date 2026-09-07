/**
 * The application's single database handle.
 *
 * Server-only. Every read and write goes through Database.withSession, which
 * binds the caller's identity to the transaction — there is no path from a
 * React component to an unbound connection.
 */
import 'server-only';
import { Database } from '../db/session';

const url =
  process.env.DATABASE_URL_APP ??
  'postgres://lotline_app:lotline_app_dev@localhost:5432/lotline';

declare global {
  // eslint-disable-next-line no-var
  var __lotlineDb: Database | undefined;
}

// Next's dev server re-evaluates modules on every edit; without this the pool
// count climbs until Postgres refuses connections.
export const db: Database = globalThis.__lotlineDb ?? new Database(url);
if (process.env.NODE_ENV !== 'production') globalThis.__lotlineDb = db;
