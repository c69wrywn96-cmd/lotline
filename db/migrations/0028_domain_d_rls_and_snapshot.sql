-- 0028 — RLS for domain D, and the instance snapshot.
--
-- Every cross-table lookup below goes through a SECURITY DEFINER helper, per
-- ADR-0026. A policy that walked itp_checkpoint -> itp_instance -> lot directly
-- would be pruned at each hop by those tables' own policies, and would fail as
-- an empty result rather than an error.

-- ---------------------------------------------------------------------------
-- Lot scope, once, as a definer helper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.can_access_lot(p_lot_id uuid, p_kind text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM lot l
     WHERE l.id = p_lot_id
       AND auth.in_scope(p_kind, l.project_id, l.zone_path, l.wbs_path,
                         l.subcontract_package_id, NULL)
  );
$$;
GRANT EXECUTE ON FUNCTION auth.can_access_lot(uuid, text)
  TO lotline_app, lotline_worker, lotline_readonly;

/** The lot a checkpoint belongs to, resolved without tripping over RLS. */
CREATE OR REPLACE FUNCTION auth.checkpoint_lot(p_checkpoint_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT i.lot_id
    FROM itp_checkpoint c JOIN itp_instance i ON i.id = c.itp_instance_id
   WHERE c.id = p_checkpoint_id;
$$;
GRANT EXECUTE ON FUNCTION auth.checkpoint_lot(uuid)
  TO lotline_app, lotline_worker, lotline_readonly;

/** The lot an instance belongs to, resolved without tripping over RLS. */
CREATE OR REPLACE FUNCTION auth.instance_lot(p_instance_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT lot_id FROM itp_instance WHERE id = p_instance_id;
$$;
GRANT EXECUTE ON FUNCTION auth.instance_lot(uuid)
  TO lotline_app, lotline_worker, lotline_readonly;

CREATE OR REPLACE FUNCTION auth.can_access_checkpoint(p_checkpoint_id uuid, p_kind text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT auth.can_access_lot(auth.checkpoint_lot(p_checkpoint_id), p_kind);
$$;
GRANT EXECUTE ON FUNCTION auth.can_access_checkpoint(uuid, text)
  TO lotline_app, lotline_worker, lotline_readonly;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
ALTER TABLE lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot FORCE ROW LEVEL SECURITY;
CREATE POLICY lot_select ON lot FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.in_scope('read', project_id, zone_path, wbs_path, subcontract_package_id, NULL));
CREATE POLICY lot_insert ON lot FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (auth.in_scope('write', project_id, zone_path, wbs_path, subcontract_package_id, NULL));
-- USING/WITH CHECK asymmetry is the JV mechanism: a partner SEES another
-- partner's lot and cannot write it, so the refusal is honest rather than a
-- pretence that the row does not exist (ADR-0020).
CREATE POLICY lot_update ON lot FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.in_scope('read', project_id, zone_path, wbs_path, subcontract_package_id, NULL))
  WITH CHECK (auth.in_scope('write', project_id, zone_path, wbs_path, subcontract_package_id, NULL));

CREATE OR REPLACE FUNCTION auth.enable_lot_scoped_rls(p_table text, p_lot_column text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format($f$
    CREATE POLICY %1$s_select ON %1$I FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
    USING (auth.can_access_lot(%2$I, 'read'))$f$, p_table, p_lot_column);
  EXECUTE format($f$
    CREATE POLICY %1$s_insert ON %1$I FOR INSERT TO lotline_app, lotline_worker
    WITH CHECK (auth.can_access_lot(%2$I, 'write'))$f$, p_table, p_lot_column);
  EXECUTE format($f$
    CREATE POLICY %1$s_update ON %1$I FOR UPDATE TO lotline_app, lotline_worker
    USING (auth.can_access_lot(%2$I, 'read'))
    WITH CHECK (auth.can_access_lot(%2$I, 'write'))$f$, p_table, p_lot_column);
END $$;

SELECT auth.enable_lot_scoped_rls('itp_instance', 'lot_id');

CREATE OR REPLACE FUNCTION auth.enable_checkpoint_scoped_rls(p_table text, p_cp_column text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format($f$
    CREATE POLICY %1$s_select ON %1$I FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
    USING (auth.can_access_checkpoint(%2$I, 'read'))$f$, p_table, p_cp_column);
  EXECUTE format($f$
    CREATE POLICY %1$s_insert ON %1$I FOR INSERT TO lotline_app, lotline_worker
    WITH CHECK (auth.can_access_checkpoint(%2$I, 'write'))$f$, p_table, p_cp_column);
  EXECUTE format($f$
    CREATE POLICY %1$s_update ON %1$I FOR UPDATE TO lotline_app, lotline_worker
    USING (auth.can_access_checkpoint(%2$I, 'read'))
    WITH CHECK (auth.can_access_checkpoint(%2$I, 'write'))$f$, p_table, p_cp_column);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checkpoint_evidence_req','checkpoint_evidence',
                           'checkpoint_state_event','witness_notification',
                           'retrospective_release','hold_release','checkpoint_correction']
  LOOP
    PERFORM auth.enable_checkpoint_scoped_rls(t, 'itp_checkpoint_id');
  END LOOP;
END $$;

-- itp_checkpoint scopes on its own instance.
ALTER TABLE itp_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE itp_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY itp_checkpoint_select ON itp_checkpoint
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.can_access_checkpoint(id, 'read'));
-- Via a definer helper, not a subquery on itp_instance: a subquery there is
-- pruned by itp_instance's own policy and the check would fail as an empty
-- result rather than an error (ADR-0026). The guard at the end of this
-- migration caught exactly that on the first attempt.
CREATE POLICY itp_checkpoint_insert ON itp_checkpoint
  FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (auth.can_access_lot(auth.instance_lot(itp_instance_id), 'write'));
CREATE POLICY itp_checkpoint_update ON itp_checkpoint
  FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.can_access_checkpoint(id, 'read'))
  WITH CHECK (auth.can_access_checkpoint(id, 'write'));

-- Library tables are reference data for any authenticated session: an ITP author
-- on any project needs the master library.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['itp_master','itp_master_version','itp_master_checkpoint',
                           'itp_master_evidence_req'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_select ON %1$I
      FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
      USING (auth.user_id() IS NOT NULL)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_insert ON %1$I
      FOR INSERT TO lotline_app, lotline_worker WITH CHECK (auth.user_id() IS NOT NULL)$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_update ON %1$I
      FOR UPDATE TO lotline_app, lotline_worker
      USING (auth.user_id() IS NOT NULL) WITH CHECK (auth.user_id() IS NOT NULL)$f$, t);
  END LOOP;
END $$;

SELECT auth.enable_project_rls('signature');
SELECT auth.enable_project_rls('signature_withdrawal');
SELECT auth.enable_project_rls('concession');

ALTER TABLE notification_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_delivery_select ON notification_delivery
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.user_id() IS NOT NULL);
CREATE POLICY notification_delivery_insert ON notification_delivery
  FOR INSERT TO lotline_app, lotline_worker WITH CHECK (auth.user_id() IS NOT NULL);
CREATE POLICY notification_delivery_update ON notification_delivery
  FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.user_id() IS NOT NULL) WITH CHECK (auth.user_id() IS NOT NULL);

ALTER TABLE retrospective_verification_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrospective_verification_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY rve_select ON retrospective_verification_evidence
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.user_id() IS NOT NULL);
CREATE POLICY rve_insert ON retrospective_verification_evidence
  FOR INSERT TO lotline_app, lotline_worker WITH CHECK (auth.user_id() IS NOT NULL);

ALTER TABLE retrospective_release_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrospective_release_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY rro_select ON retrospective_release_outcome
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.user_id() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- The snapshot (ADR-0008)
-- ---------------------------------------------------------------------------
/**
 * Copies a PUBLISHED master version into an immutable instance on a lot.
 *
 * Physical copy, not a pointer. There is no FK path by which editing the master
 * later reaches this instance, which is the whole reason a later ITP revision
 * cannot retroactively alter a closed lot.
 */
CREATE OR REPLACE FUNCTION public.snapshot_itp(
  p_lot_id uuid, p_master_version_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v record; l record; inst_id uuid; cp record; new_cp uuid;
BEGIN
  SELECT * INTO l FROM lot WHERE id = p_lot_id;
  IF l IS NULL THEN RAISE EXCEPTION 'LOTLINE_LOT_MISSING'; END IF;

  SELECT * INTO v FROM itp_master_version WHERE id = p_master_version_id;
  IF v IS NULL THEN RAISE EXCEPTION 'LOTLINE_ITP_VERSION_MISSING'; END IF;
  IF v.status <> 'published' THEN
    RAISE EXCEPTION
      'LOTLINE_ITP_NOT_PUBLISHED: a lot can only be raised against a published ITP version (this one is %)',
      v.status;
  END IF;

  INSERT INTO itp_instance (project_id, lot_id, itp_master_version_id, content_hash, snapshotted_by)
  VALUES (l.project_id, p_lot_id, p_master_version_id, v.content_hash, auth.user_id())
  RETURNING id INTO inst_id;

  FOR cp IN
    SELECT * FROM itp_master_checkpoint
     WHERE itp_master_version_id = p_master_version_id ORDER BY sequence_no
  LOOP
    INSERT INTO itp_checkpoint
      (project_id, itp_instance_id, source_checkpoint_id, sequence_no, activity,
       checkpoint_type, responsible_party, release_role_id, acceptance_criteria,
       notice_hours, blocking_scope, subcontract_package_id)
    VALUES
      (l.project_id, inst_id, cp.id, cp.sequence_no, cp.activity,
       cp.checkpoint_type, cp.responsible_party, cp.release_role_id, cp.acceptance_criteria,
       cp.notice_hours, cp.blocking_scope, l.subcontract_package_id)
    RETURNING id INTO new_cp;

    INSERT INTO checkpoint_evidence_req
      (itp_checkpoint_id, evidence_type, min_count, mandatory, description)
    SELECT new_cp, evidence_type, min_count, mandatory, description
      FROM itp_master_evidence_req WHERE itp_master_checkpoint_id = cp.id;
  END LOOP;

  RETURN inst_id;
END $$;
GRANT EXECUTE ON FUNCTION public.snapshot_itp(uuid, uuid) TO lotline_app, lotline_worker;

/** Canonical hash of a version's content, for publish-time pinning. */
CREATE OR REPLACE FUNCTION public.itp_version_content_hash(p_version_id uuid)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(digest(string_agg(
           format('%s|%s|%s|%s|%s|%s|%s',
                  sequence_no, activity, checkpoint_type, responsible_party,
                  COALESCE(release_role_id::text,''), acceptance_criteria, blocking_scope),
           E'\n' ORDER BY sequence_no), 'sha256'), 'hex')
    FROM itp_master_checkpoint WHERE itp_master_version_id = p_version_id;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lot','itp_master','itp_master_version','itp_master_checkpoint','itp_master_evidence_req',
    'itp_instance','itp_checkpoint','checkpoint_evidence_req','checkpoint_evidence',
    'witness_notification','concession','hold_release','retrospective_release',
    'checkpoint_correction','signature','signature_withdrawal'
  ] LOOP
    PERFORM audit.attach(t);
  END LOOP;
END $$;

SELECT public.revoke_delete_everywhere();

-- The guard from ADR-0026 must still be clean after adding 30-odd policies.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s -> %s', on_table, policy_name, referenced_table), '; ')
    INTO bad FROM audit.rls_reference_risks();
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_UNDECLARED_RLS_REFERENCE: %', bad;
  END IF;
END $$;
