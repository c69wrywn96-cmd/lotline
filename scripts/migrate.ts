/**
 * Migration runner.
 *
 * Deliberately not drizzle-kit: the authoritative schema artefact for this
 * product is hand-written SQL, because RLS policies, security-definer guard
 * functions, generated columns, partial unique indexes and revoked privileges
 * are the substance of the design and none of them round-trip through an ORM's
 * schema differ. Drizzle's TypeScript schema mirrors these migrations for
 * application-layer typing; it does not generate them.
 *
 * Each file is applied once, in filename order, inside its own transaction, and
 * recorded with a hash so a changed applied migration is an error rather than a
 * silent divergence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'db', 'migrations');

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgres://postgres@localhost:5432/lotline';
const reset = process.argv.includes('--reset');

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function ensureDatabase(): Promise<void> {
  const url = new URL(ownerUrl);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(ownerUrl);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    if (reset) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(dbName).replace(/"/g, '"')}`);
      console.log(`  dropped database ${dbName}`);
    }
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      console.log(`  created database ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  await ensureDatabase();

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let applied = 0;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const hash = sha256(sql);

    const ledgerExists = await client.query(
      `SELECT to_regclass('public._migration') IS NOT NULL AS present`,
    );
    if (ledgerExists.rows[0]?.present) {
      const prior = await client.query('SELECT sha256 FROM _migration WHERE filename = $1', [
        file,
      ]);
      if (prior.rowCount && prior.rowCount > 0) {
        if (prior.rows[0].sha256 !== hash) {
          throw new Error(
            `Migration ${file} has changed since it was applied.\n` +
              `Applied migrations are immutable — add a new migration instead.`,
          );
        }
        continue;
      }
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        `INSERT INTO _migration (filename, sha256) VALUES ($1, $2)
         ON CONFLICT (filename) DO NOTHING`,
        [file, hash],
      );
      await client.query('COMMIT');
      console.log(`  applied ${file}`);
      applied += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`\nFailed applying ${file}:\n`);
      throw err;
    }
  }

  await client.end();
  console.log(applied === 0 ? 'Database up to date.' : `Applied ${applied} migration(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
