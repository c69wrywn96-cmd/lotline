-- 0000 — Extensions, database roles, schemas and session helpers.
--
-- The security posture established here is load-bearing for the entire system:
--   * lotline_app is NOT the table owner, because a table owner bypasses RLS
--     regardless of NOBYPASSRLS. This is the most common way Postgres RLS is
--     silently defeated.
--   * DELETE is revoked from every application role, everywhere, forever.
--     See ADR-0003. There is no delete in this product.
--   * Identity arrives through transaction-local GUCs. Unset GUCs mean
--     auth.user_id() is NULL, every policy predicate is false, and every table
--     reads as empty. Fail closed.

CREATE EXTENSION IF NOT EXISTS postgis;      -- spatial from day one, ADR-0004
CREATE EXTENSION IF NOT EXISTS ltree;        -- zone/WBS subtree scoping, ADR-0020
CREATE EXTENSION IF NOT EXISTS citext;       -- email identity must not fork on case
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- exclusion constraints mixing uuid + range

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------------------
-- Database roles
-- ---------------------------------------------------------------------------
-- Passwords here are development values. Production credentials are injected by
-- the deployment; these roles are created NOLOGIN-safe by being granted only
-- what they need.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lotline_owner') THEN
    CREATE ROLE lotline_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lotline_app') THEN
    CREATE ROLE lotline_app LOGIN PASSWORD 'lotline_app_dev' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lotline_worker') THEN
    CREATE ROLE lotline_worker LOGIN PASSWORD 'lotline_worker_dev' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lotline_readonly') THEN
    CREATE ROLE lotline_readonly LOGIN PASSWORD 'lotline_ro_dev' NOBYPASSRLS;
  END IF;
END $$;

-- Belt and braces: even if a superuser later ALTERs one of these, the migration
-- suite asserts the attribute (see tests/rls.test.ts).
ALTER ROLE lotline_app      NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE lotline_worker   NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE lotline_readonly NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public, auth, audit TO lotline_app, lotline_worker, lotline_readonly;

-- Default privileges for everything created later in this migration set.
-- Note the deliberate absence of DELETE in every grant below.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO lotline_app, lotline_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO lotline_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lotline_app, lotline_worker;

-- ---------------------------------------------------------------------------
-- Session context
-- ---------------------------------------------------------------------------
-- Every request runs inside one transaction that begins with SET LOCAL of these
-- GUCs. SET LOCAL (not SET) matters: with a connection pooler a session-scoped
-- SET leaks one user's identity into the next request.

CREATE OR REPLACE FUNCTION auth.user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.request_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.request_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.ip() RETURNS inet
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.ip', true), '')::inet
$$;

CREATE OR REPLACE FUNCTION auth.user_agent() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.user_agent', true), '')
$$;

CREATE OR REPLACE FUNCTION auth.device_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.device_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.auth_event_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.auth_event_id', true), '')::uuid
$$;

-- uuid v7: time-ordered, so index locality holds at 10k+ lots per project.
-- Postgres 18 has uuidv7() natively; this is the portable implementation.
CREATE OR REPLACE FUNCTION public.uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);
  -- version 7
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  -- variant 10xx
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10'   || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END $$;

-- ---------------------------------------------------------------------------
-- Migration ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _migration (
  filename    text PRIMARY KEY,
  sha256      text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
