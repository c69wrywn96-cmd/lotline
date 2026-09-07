/**
 * Rebuilds the database from migrations and reseeds before the suite runs.
 * Tests assert against real seeded rows, never fixtures.
 */
import { execFileSync } from 'node:child_process';

export default async function setup(): Promise<void> {
  const env = {
    ...process.env,
    DATABASE_URL_OWNER:
      process.env.DATABASE_URL_OWNER ?? 'postgres://postgres:postgres@localhost:5432/lotline',
  };
  const run = (script: string) =>
    execFileSync('npx', ['tsx', script], { env, stdio: 'pipe', encoding: 'utf8' });

  run('scripts/migrate.ts');
  // --reset is intentional: an RLS suite that runs against a dirty database
  // proves nothing.
  execFileSync('npx', ['tsx', 'scripts/migrate.ts', '--reset'], {
    env, stdio: 'pipe', encoding: 'utf8',
  });
  run('seed/seed.ts');
}
