-- 0007 — Row-level security.
--
-- FORCE ROW LEVEL SECURITY on every table so policies apply even if ownership is
-- ever misconfigured. No DELETE policy is created anywhere, and DELETE is already
-- revoked — both, deliberately.
--
-- The USING / WITH CHECK asymmetry on UPDATE is the JV mechanism: a partner may
-- SEE a row in another partner's zone (so it appears in registers, maps and
-- exports) and any attempt to write it fails the WITH CHECK. Postgres reports
-- that as a policy violation, which the application surfaces as "outside your
-- assigned sections" — not as "not found", because the row is legitimately
-- visible.

-- ---------------------------------------------------------------------------
-- Project-scoped tables: visibility follows the project read grant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.enable_project_rls(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);

  EXECUTE format($f$
    CREATE POLICY %1$s_select ON %1$I FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
    USING (auth.in_scope('read', project_id))
  $f$, p_table);

  EXECUTE format($f$
    CREATE POLICY %1$s_insert ON %1$I FOR INSERT TO lotline_app, lotline_worker
    WITH CHECK (auth.in_scope('write', project_id))
  $f$, p_table);

  EXECUTE format($f$
    CREATE POLICY %1$s_update ON %1$I FOR UPDATE TO lotline_app, lotline_worker
    USING (auth.in_scope('read', project_id))
    WITH CHECK (auth.in_scope('write', project_id))
  $f$, p_table);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contract','project_participant','discipline','subcontract_package',
    'alignment','work_type','lot_number_scheme',
    'coordinate_system','project_membership'
  ] LOOP
    PERFORM auth.enable_project_rls(t);
  END LOOP;
END $$;

-- Join table with no project_id of its own; scope follows its contract.
ALTER TABLE contract_acceptance_work_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_acceptance_work_type FORCE ROW LEVEL SECURITY;
CREATE POLICY cawt_select ON contract_acceptance_work_type
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (EXISTS (SELECT 1 FROM contract c
                  WHERE c.id = contract_acceptance_work_type.contract_id
                    AND auth.in_scope('read', c.project_id)));
CREATE POLICY cawt_insert ON contract_acceptance_work_type
  FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (EXISTS (SELECT 1 FROM contract c
                       WHERE c.id = contract_acceptance_work_type.contract_id
                         AND auth.in_scope('write', c.project_id)));

-- ---------------------------------------------------------------------------
-- Zone and WBS: readable per project grant, writable per subtree grant. These
-- are the tables whose own path drives scope containment.
-- ---------------------------------------------------------------------------
ALTER TABLE zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE zone FORCE ROW LEVEL SECURITY;
CREATE POLICY zone_select ON zone FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.in_scope('read', project_id, path, NULL, NULL, NULL));
CREATE POLICY zone_insert ON zone FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (auth.in_scope('write', project_id));
CREATE POLICY zone_update ON zone FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.in_scope('read', project_id, path, NULL, NULL, NULL))
  WITH CHECK (auth.in_scope('write', project_id, path, NULL, NULL, NULL));

ALTER TABLE wbs_element ENABLE ROW LEVEL SECURITY;
ALTER TABLE wbs_element FORCE ROW LEVEL SECURITY;
CREATE POLICY wbs_select ON wbs_element FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.in_scope('read', project_id, NULL, path, NULL, NULL));
CREATE POLICY wbs_insert ON wbs_element FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (auth.in_scope('write', project_id, NULL, path, NULL, NULL));
CREATE POLICY wbs_update ON wbs_element FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.in_scope('read', project_id, NULL, path, NULL, NULL))
  WITH CHECK (auth.in_scope('write', project_id, NULL, path, NULL, NULL));

ALTER TABLE alignment_equation ENABLE ROW LEVEL SECURITY;
ALTER TABLE alignment_equation FORCE ROW LEVEL SECURITY;
CREATE POLICY alignment_equation_select ON alignment_equation
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (EXISTS (SELECT 1 FROM alignment a
                  WHERE a.id = alignment_equation.alignment_id
                    AND auth.in_scope('read', a.project_id)));
CREATE POLICY alignment_equation_write ON alignment_equation
  FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (EXISTS (SELECT 1 FROM alignment a
                       WHERE a.id = alignment_equation.alignment_id
                         AND auth.in_scope('write', a.project_id)));

-- ---------------------------------------------------------------------------
-- Project itself: visible if you hold any read grant on it.
-- ---------------------------------------------------------------------------
ALTER TABLE project ENABLE ROW LEVEL SECURITY;
ALTER TABLE project FORCE ROW LEVEL SECURITY;
CREATE POLICY project_select ON project FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.in_scope('read', id));
CREATE POLICY project_update ON project FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.in_scope('read', id))
  WITH CHECK (auth.in_scope('write', id));

ALTER TABLE vertical_datum ENABLE ROW LEVEL SECURITY;
ALTER TABLE vertical_datum FORCE ROW LEVEL SECURITY;
-- System datums (project_id IS NULL) are reference data and readable by all.
CREATE POLICY vertical_datum_select ON vertical_datum
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (project_id IS NULL OR auth.in_scope('read', project_id));
CREATE POLICY vertical_datum_insert ON vertical_datum FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (project_id IS NOT NULL AND auth.in_scope('write', project_id));

-- ---------------------------------------------------------------------------
-- Identity tables: a user always sees themselves, plus anyone who shares a
-- project with them. Without the second clause no register could render a
-- signatory's name.
-- ---------------------------------------------------------------------------
ALTER TABLE user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account FORCE ROW LEVEL SECURITY;
CREATE POLICY user_account_select ON user_account
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (
    id = auth.user_id()
    OR EXISTS (
      SELECT 1 FROM access_grant mine
      JOIN access_grant theirs
        ON theirs.project_id = mine.project_id AND theirs.user_id = user_account.id
      WHERE mine.user_id = auth.user_id()
    )
  );
CREATE POLICY user_account_update ON user_account FOR UPDATE TO lotline_app, lotline_worker
  USING (id = auth.user_id()) WITH CHECK (id = auth.user_id());

ALTER TABLE organisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_select ON organisation
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (
    EXISTS (
      SELECT 1 FROM project_participant pp
      JOIN access_grant g ON g.project_id = pp.project_id AND g.user_id = auth.user_id()
      WHERE pp.organisation_id = organisation.id
    )
    OR id = (SELECT primary_org_id FROM user_account WHERE id = auth.user_id())
  );

-- access_grant: a user sees only their own grants. This matters because the
-- table is the map of who can see what.
ALTER TABLE access_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY access_grant_select ON access_grant
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (user_id = auth.user_id());

-- Credentials are never readable through the data path, by anyone, ever.
-- The application authenticates through a separate privileged path.
ALTER TABLE auth_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_credential FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_totp ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_totp FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_passkey ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_passkey FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_passkey_self ON auth_passkey FOR SELECT TO lotline_app
  USING (user_id = auth.user_id());

-- Devices and unlocks: visible within the project, so a supervisor can see and
-- revoke the tablets on their site.
ALTER TABLE device ENABLE ROW LEVEL SECURITY;
ALTER TABLE device FORCE ROW LEVEL SECURITY;
CREATE POLICY device_select ON device FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (project_id IS NOT NULL AND auth.in_scope('read', project_id));
CREATE POLICY device_write ON device FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (project_id IS NOT NULL AND auth.in_scope('write', project_id));
CREATE POLICY device_update ON device FOR UPDATE TO lotline_app, lotline_worker
  USING (project_id IS NOT NULL AND auth.in_scope('read', project_id))
  WITH CHECK (project_id IS NOT NULL AND auth.in_scope('write', project_id));

ALTER TABLE device_user_enrolment ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_user_enrolment FORCE ROW LEVEL SECURITY;
CREATE POLICY device_user_enrolment_select ON device_user_enrolment
  FOR SELECT TO lotline_app, lotline_worker
  USING (user_id = auth.user_id()
         OR EXISTS (SELECT 1 FROM device d WHERE d.id = device_id
                      AND d.project_id IS NOT NULL AND auth.in_scope('read', d.project_id)));

ALTER TABLE authentication_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE authentication_event FORCE ROW LEVEL SECURITY;
CREATE POLICY authentication_event_select ON authentication_event
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (user_id = auth.user_id());

-- ---------------------------------------------------------------------------
-- The audit log is scoped like everything else. An auditor with project read
-- sees the project's log; nobody sees another project's.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_select ON audit_log_entry
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (project_id IS NOT NULL AND auth.in_scope('read', project_id));
-- INSERT is performed by the SECURITY DEFINER audit trigger, which runs as the
-- table owner and is therefore not constrained by this policy. No INSERT policy
-- is granted to the application directly.

-- ---------------------------------------------------------------------------
-- Reference data readable by any authenticated session.
-- ---------------------------------------------------------------------------
ALTER TABLE unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit FORCE ROW LEVEL SECURITY;
CREATE POLICY unit_select ON unit FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.user_id() IS NOT NULL);

ALTER TABLE permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission FORCE ROW LEVEL SECURITY;
CREATE POLICY permission_select ON permission FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.user_id() IS NOT NULL);

ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;
CREATE POLICY role_select ON role FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.user_id() IS NOT NULL);

ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permission_select ON role_permission
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.user_id() IS NOT NULL);

ALTER TABLE org_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY org_membership_select ON org_membership
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (user_id = auth.user_id()
         OR EXISTS (SELECT 1 FROM access_grant g
                     WHERE g.user_id = auth.user_id()
                       AND g.project_id IN (SELECT project_id FROM project_participant
                                             WHERE organisation_id = org_membership.organisation_id)));

-- Remaining domain-A tables default-deny: RLS on with no permissive policy for
-- the application role. Nothing reads them through the data path.
ALTER TABLE org_identity_provider ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_identity_provider FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identity FORCE ROW LEVEL SECURITY;
ALTER TABLE permission_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY permission_grant_select ON permission_grant FOR SELECT TO lotline_app
  USING (user_id = auth.user_id());
ALTER TABLE delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation FORCE ROW LEVEL SECURITY;
CREATE POLICY delegation_select ON delegation FOR SELECT TO lotline_app
  USING (to_user_id = auth.user_id() OR from_user_id = auth.user_id());
ALTER TABLE unfrozen_column ENABLE ROW LEVEL SECURITY;
ALTER TABLE unfrozen_column FORCE ROW LEVEL SECURITY;
CREATE POLICY unfrozen_column_select ON unfrozen_column FOR SELECT TO lotline_app, lotline_worker
  USING (true);
ALTER TABLE _migration ENABLE ROW LEVEL SECURITY;
ALTER TABLE _migration FORCE ROW LEVEL SECURITY;
