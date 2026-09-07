-- 0010 — Two defects found by the Phase 1 test suite.
--
-- (1) `AFTER UPDATE OF path` fires only when `path` appears in the UPDATE
--     statement's SET clause — NOT when the value changes. Since `path` is
--     derived by a BEFORE trigger and never named by application code, the
--     subtree cascade never ran: renaming or re-parenting a zone left every
--     descendant's path stale, and with it access_grant.scope_path, so a write
--     scope would silently point at a subtree that no longer exists. Exactly the
--     failure the resync trigger was written to prevent.
--
--     Fixed by firing on any UPDATE and guarding on an actual path change.
--
-- (2) audit_log_entry inherited the default SELECT/INSERT/UPDATE grant, so the
--     application could rewrite history. It and authentication_event are
--     insert-only; UPDATE is now revoked.

-- --------------------------------------------------------------------------
-- (1) Subtree cascades
-- --------------------------------------------------------------------------
DROP TRIGGER IF EXISTS zone_path_cascade ON zone;
CREATE TRIGGER zone_path_cascade AFTER UPDATE ON zone
  FOR EACH ROW WHEN (NEW.path IS DISTINCT FROM OLD.path)
  EXECUTE FUNCTION public.cascade_zone_path();

DROP TRIGGER IF EXISTS wbs_path_cascade ON wbs_element;
CREATE TRIGGER wbs_path_cascade AFTER UPDATE ON wbs_element
  FOR EACH ROW WHEN (NEW.path IS DISTINCT FROM OLD.path)
  EXECUTE FUNCTION public.cascade_wbs_path();

DROP TRIGGER IF EXISTS zone_grant_path_resync ON zone;
CREATE TRIGGER zone_grant_path_resync AFTER UPDATE ON zone
  FOR EACH ROW WHEN (NEW.path IS DISTINCT FROM OLD.path)
  EXECUTE FUNCTION auth.tg_resync_scope_paths();

DROP TRIGGER IF EXISTS wbs_grant_path_resync ON wbs_element;
CREATE TRIGGER wbs_grant_path_resync AFTER UPDATE ON wbs_element
  FOR EACH ROW WHEN (NEW.path IS DISTINCT FROM OLD.path)
  EXECUTE FUNCTION auth.tg_resync_scope_paths();

-- Repair any paths already stale in an existing database. Idempotent.
CREATE OR REPLACE FUNCTION public.rebuild_all_paths() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Touching each row re-runs the BEFORE trigger, which recomputes from parent.
  UPDATE zone SET code = code;
  UPDATE wbs_element SET wbs_code = wbs_code;
  UPDATE access_grant g SET scope_path = z.path
    FROM zone z WHERE g.scope_type = 'zone' AND g.scope_id = z.id
      AND g.scope_path IS DISTINCT FROM z.path;
  UPDATE access_grant g SET scope_path = w.path
    FROM wbs_element w WHERE g.scope_type = 'wbs' AND g.scope_id = w.id
      AND g.scope_path IS DISTINCT FROM w.path;
END $$;
SELECT public.rebuild_all_paths();

-- --------------------------------------------------------------------------
-- (2) Insert-only tables
-- --------------------------------------------------------------------------
REVOKE UPDATE ON audit_log_entry      FROM lotline_app, lotline_worker, lotline_readonly;
REVOKE UPDATE ON authentication_event FROM lotline_app, lotline_worker, lotline_readonly;

DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
     WHERE parent.relname = 'audit_log_entry'
  LOOP
    EXECUTE format('REVOKE UPDATE ON %I FROM lotline_app, lotline_worker, lotline_readonly', p.relname);
  END LOOP;
END $$;

-- Future monthly partitions must inherit the same posture.
CREATE OR REPLACE FUNCTION audit.ensure_partition(p_when timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  start_ts date := date_trunc('month', p_when)::date;
  end_ts   date := (date_trunc('month', p_when) + interval '1 month')::date;
  part     text := format('audit_log_entry_%s', to_char(start_ts, 'YYYY_MM'));
BEGIN
  IF to_regclass('public.' || part) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log_entry FOR VALUES FROM (%L) TO (%L)',
      part, start_ts, end_ts);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO lotline_app, lotline_worker', part);
    EXECUTE format('GRANT SELECT ON %I TO lotline_readonly', part);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM lotline_app, lotline_worker, lotline_readonly', part);
  END IF;
END $$;
