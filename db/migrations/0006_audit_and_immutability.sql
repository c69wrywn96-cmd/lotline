-- 0006 — Append-only audit log and the immutability posture (ADR-0003, ADR-0013).
--
-- The audit log is written by TRIGGER, not by application code, because
-- application-level audit logging is forgettable and the one path that forgets is
-- the one an auditor finds.

CREATE TABLE audit_log_entry (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  project_id    uuid,
  actor_user_id uuid,
  actor_org_id  uuid,
  action        text        NOT NULL
                CHECK (action IN ('insert','update','sign','release','view_restricted',
                                  'export','login','permission_change','delete_attempt')),
  subject_type  text        NOT NULL,
  subject_id    uuid,
  before_value  jsonb,
  after_value   jsonb,
  ip_address    inet,
  user_agent    text,
  request_id    uuid,
  device_id     uuid,
  auth_event_id uuid,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_log_subject ON audit_log_entry (subject_type, subject_id);
CREATE INDEX audit_log_project ON audit_log_entry (project_id, occurred_at DESC);
CREATE INDEX audit_log_actor   ON audit_log_entry (actor_user_id, occurred_at DESC);

-- Monthly partitions. Old partitions are DETACHED to cold storage at the
-- contract's retention horizon, never dropped.
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
  END IF;
END $$;

SELECT audit.ensure_partition(now() - interval '1 month');
SELECT audit.ensure_partition(now());
SELECT audit.ensure_partition(now() + interval '1 month');
SELECT audit.ensure_partition(now() + interval '2 month');

-- ---------------------------------------------------------------------------
-- The audit trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, audit AS $$
DECLARE
  v_project_id uuid;
  v_subject_id uuid;
BEGIN
  BEGIN
    v_project_id := COALESCE(
      (to_jsonb(NEW) ->> 'project_id')::uuid,
      (to_jsonb(OLD) ->> 'project_id')::uuid
    );
  EXCEPTION WHEN others THEN v_project_id := NULL;
  END;

  BEGIN
    v_subject_id := COALESCE(
      (to_jsonb(NEW) ->> 'id')::uuid,
      (to_jsonb(OLD) ->> 'id')::uuid
    );
  EXCEPTION WHEN others THEN v_subject_id := NULL;
  END;

  INSERT INTO audit_log_entry (
    project_id, actor_user_id, action, subject_type, subject_id,
    before_value, after_value, ip_address, user_agent, request_id,
    device_id, auth_event_id, occurred_at
  ) VALUES (
    v_project_id,
    auth.user_id(),
    lower(TG_OP),
    TG_TABLE_NAME,
    v_subject_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    auth.ip(), auth.user_agent(), auth.request_id(),
    auth.device_id(), auth.auth_event_id(), now()
  );
  RETURN COALESCE(NEW, OLD);
END $$;

-- Attach to every business table that exists at this point. Later migrations
-- call audit.attach() for their own tables.
CREATE OR REPLACE FUNCTION audit.attach(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS zzz_audit ON %I', p_table);
  EXECUTE format(
    'CREATE TRIGGER zzz_audit AFTER INSERT OR UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit.record()', p_table);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organisation','user_account','org_identity_provider','auth_identity',
    'device','device_user_enrolment','role','role_permission','org_membership',
    'permission_grant','delegation','project','contract','project_participant',
    'discipline','subcontract_package','alignment','alignment_equation','zone',
    'wbs_element','work_type','contract_acceptance_work_type','lot_number_scheme',
    'vertical_datum','project_membership'
  ] LOOP
    PERFORM audit.attach(t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Immutability, mechanism 1: DELETE is revoked. Everywhere. Always.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_delete_everywhere() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM lotline_app, lotline_worker, lotline_readonly',
                   t.tablename);
  END LOOP;
END $$;
SELECT public.revoke_delete_everywhere();

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE DELETE, TRUNCATE ON TABLES FROM lotline_app, lotline_worker, lotline_readonly;

-- ---------------------------------------------------------------------------
-- Immutability, mechanism 2: the lock trigger.
-- ---------------------------------------------------------------------------
-- A locked row admits changes only to its enumerated unfrozen columns. The
-- default set is supersession plus bookkeeping; individual tables extend it (lot
-- adds client_accepted_at, per ADR-0022 / guard G19).
CREATE TABLE unfrozen_column (
  table_name  text NOT NULL,
  column_name text NOT NULL,
  reason      text NOT NULL,
  PRIMARY KEY (table_name, column_name)
);

CREATE OR REPLACE FUNCTION public.assert_not_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed text;
  allowed text[];
BEGIN
  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;

  SELECT array_agg(column_name) INTO allowed
    FROM unfrozen_column WHERE table_name = TG_TABLE_NAME;
  allowed := COALESCE(allowed, ARRAY[]::text[])
             || ARRAY['superseded_by_id','superseded_at','supersede_reason','updated_at','updated_by'];

  SELECT string_agg(key, ', ') INTO changed
  FROM (
    SELECT key FROM jsonb_each(to_jsonb(NEW))
    EXCEPT
    SELECT key FROM jsonb_each(to_jsonb(OLD))
  ) AS diff(key)
  WHERE key <> ALL (allowed);

  IF changed IS NULL THEN
    -- also catch value changes on shared keys
    SELECT string_agg(n.key, ', ') INTO changed
    FROM jsonb_each(to_jsonb(NEW)) n
    JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key <> ALL (allowed);
  END IF;

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_RECORD_LOCKED: % is signed; cannot modify %',
      TG_TABLE_NAME, changed;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.assert_not_locked IS
  'Attach BEFORE UPDATE to any table with a locked_at column. Correction is supersession (ADR-0003).';
