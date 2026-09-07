#!/usr/bin/env bash
# Local Postgres 16 + PostGIS 3.4 for development and the test suite.
# Production runs a managed instance in an Australian region (OQ-10 outstanding).
set -euo pipefail

if ! command -v psql >/dev/null; then
  echo "PostgreSQL client not found. Install postgresql-16 and postgresql-16-postgis-3." >&2
  exit 1
fi

if ! pg_isready -q; then
  echo "Starting PostgreSQL..."
  service postgresql start || pg_ctlcluster 16 main start
  for _ in $(seq 1 20); do pg_isready -q && break; sleep 0.5; done
fi

# The migration runner connects as the owner and creates the database itself.
su postgres -c "psql -tAc \"ALTER ROLE postgres PASSWORD 'postgres'\"" >/dev/null 2>&1 || true

echo "PostgreSQL ready: $(psql -h localhost -U postgres -d postgres -tAc 'SELECT version()' 2>/dev/null | head -c 40)..."
echo "Run: npm run db:reset && npm run db:seed && npm test"
