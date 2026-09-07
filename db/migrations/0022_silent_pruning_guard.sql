-- 0022 — Guarding against silent RLS pruning.
--
-- THE CLASS (ADR-0026): a policy predicate, or a SECURITY INVOKER function used
-- for a cross-user lookup, that reads another RLS-enabled table. Postgres
-- applies that table's own policy inside the predicate, so the lookup can only
-- ever see the CALLER'S rows. A question about somebody else silently answers
-- "no rows".
--
-- It is worse than a denial because there is no denial. The query returns 200
-- with an empty array, the screen renders blank, the log records nothing, and
-- the user assumes there is nothing to see. Six instances were found in Phase 1,
-- every one of them only when a screen first needed to display another person's
-- data.
--
-- Two mechanisms, per the design review:
--   1. Make SECURITY DEFINER the shape cross-user lookups actually take, rather
--      than the shape they are supposed to take.
--   2. A registry that forces every remaining policy->RLS-table reference to be
--      declared as deliberate, and a detector that fails the build on an
--      undeclared one.

-- ---------------------------------------------------------------------------
-- 1. The most important predicate in the system stops depending on a policy.
-- ---------------------------------------------------------------------------
-- auth.in_scope reads access_grant, which is itself RLS-enabled. It only ever
-- asks about the caller's own grants, so pruning is harmless TODAY -- but if
-- access_grant's policy were ever tightened, every in_scope call in every policy
-- would start returning false and the entire database would read as empty. That
-- coupling should not exist at all.
ALTER FUNCTION auth.in_scope(text, uuid, ltree, ltree, uuid, uuid)
  SECURITY DEFINER SET search_path = public, auth;

-- ---------------------------------------------------------------------------
-- 2. Convert the genuinely cross-user lookups to definer helpers.
-- ---------------------------------------------------------------------------

/** Does the caller administer this user, on any project the user belongs to? */
CREATE OR REPLACE FUNCTION auth.administers_user(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_membership pm
     WHERE pm.user_id = p_user_id
       AND pm.active_period @> CURRENT_DATE
       AND auth.has_permission('admin.users.manage', pm.project_id)
  );
$$;
GRANT EXECUTE ON FUNCTION auth.administers_user(uuid) TO lotline_app, lotline_worker;

DROP POLICY IF EXISTS identity_link_request_select ON identity_link_request;
CREATE POLICY identity_link_request_select ON identity_link_request
  FOR SELECT TO lotline_app, lotline_worker
  USING (
    user_id = auth.user_id()
    OR initiated_by = auth.user_id()
    OR auth.administers_user(user_id)
  );

/** Can the caller see this organisation? Fences externals from each other. */
CREATE OR REPLACE FUNCTION auth.can_see_organisation(p_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT
    p_org_id = (SELECT primary_org_id FROM user_account WHERE id = auth.user_id())
    OR EXISTS (
      SELECT 1
        FROM project_participant pp
        JOIN access_grant g ON g.project_id = pp.project_id
                           AND g.user_id = auth.user_id()
                           AND g.grant_kind = 'read'
       WHERE pp.organisation_id = p_org_id
         AND (g.side <> 'external' OR pp.participation NOT IN ('subcontractor','supplier'))
    );
$$;
GRANT EXECUTE ON FUNCTION auth.can_see_organisation(uuid)
  TO lotline_app, lotline_worker, lotline_readonly;

DROP POLICY IF EXISTS organisation_select ON organisation;
CREATE POLICY organisation_select ON organisation
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.can_see_organisation(id));

/** Org memberships visible to the caller: their own, or those of people they can see. */
CREATE OR REPLACE FUNCTION auth.can_see_org_membership(p_user_id uuid, p_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT p_user_id = auth.user_id()
      OR (auth.shares_project_with(p_user_id) AND auth.can_see_organisation(p_org_id));
$$;
GRANT EXECUTE ON FUNCTION auth.can_see_org_membership(uuid, uuid)
  TO lotline_app, lotline_worker, lotline_readonly;

DROP POLICY IF EXISTS org_membership_select ON org_membership;
CREATE POLICY org_membership_select ON org_membership
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.can_see_org_membership(user_id, organisation_id));

-- The OQ-19 unstick valve was itself an instance of the class. It reads
-- project_membership, role_permission, org_membership and project_participant
-- as SECURITY INVOKER, so for a caller who cannot read those rows it returned
-- NO eligible counter-signatories -- presenting "there is nobody who can
-- counter-sign this" when in fact there was. The existing test passed only
-- because it ran as the owner. Found by the detector below, before the ITP
-- tables landed, which is the whole point of pulling this forward.
ALTER FUNCTION auth.eligible_withdrawal_countersignatories(uuid, uuid)
  SECURITY DEFINER SET search_path = public, auth;
GRANT EXECUTE ON FUNCTION auth.eligible_withdrawal_countersignatories(uuid, uuid)
  TO lotline_app, lotline_worker;

-- ---------------------------------------------------------------------------
-- 3. The declaration registry.
-- ---------------------------------------------------------------------------
CREATE TABLE rls_reference_declaration (
  on_table         text NOT NULL,
  policy_name      text NOT NULL,
  referenced_table text NOT NULL,
  disposition      text NOT NULL
                   CHECK (disposition IN ('pruning_intended','definer_path')),
  reason           text NOT NULL,
  declared_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (on_table, policy_name, referenced_table)
);
COMMENT ON TABLE rls_reference_declaration IS
  'Every policy that references another RLS-enabled table must be declared here. "pruning_intended" means the nested policy filtering IS the fence and a cross-user answer would be wrong. Anything undeclared fails audit.rls_reference_risks().';

ALTER TABLE rls_reference_declaration ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_reference_declaration FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_reference_declaration_select ON rls_reference_declaration
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.user_id() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4. The detector.
-- ---------------------------------------------------------------------------
-- pg_depend, not a regex over policy text: it records the exact relations a
-- policy expression depends on, so there are no false positives to teach people
-- to ignore. (A regex over `\mproject\M` flagged contract_update, which does not
-- reference the project table at all.)
CREATE OR REPLACE VIEW audit.rls_policy_references AS
  SELECT DISTINCT
         cls.relname  AS on_table,
         p.polname    AS policy_name,
         ref.relname  AS referenced_table
    FROM pg_depend d
    JOIN pg_policy p  ON p.oid = d.objid  AND d.classid    = 'pg_policy'::regclass
    JOIN pg_class cls ON cls.oid = p.polrelid
    JOIN pg_class ref ON ref.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
    JOIN pg_namespace rn ON rn.oid = ref.relnamespace
   WHERE rn.nspname = 'public'
     AND ref.relkind IN ('r','p')
     AND ref.relrowsecurity
     AND ref.relname <> cls.relname;   -- self-reference cannot prune cross-user

CREATE OR REPLACE FUNCTION audit.rls_reference_risks()
RETURNS TABLE (on_table text, policy_name text, referenced_table text)
LANGUAGE sql STABLE AS $$
  SELECT r.on_table, r.policy_name, r.referenced_table
    FROM audit.rls_policy_references r
   WHERE NOT EXISTS (
     SELECT 1 FROM rls_reference_declaration d
      WHERE d.on_table = r.on_table
        AND d.policy_name = r.policy_name
        AND d.referenced_table = r.referenced_table
   );
$$;
COMMENT ON FUNCTION audit.rls_reference_risks IS
  'Undeclared policy references to RLS-enabled tables. Must be empty: each is a place a cross-user question can silently answer "no rows" (ADR-0026).';

/**
 * Functions used inside policies must be SECURITY DEFINER with a pinned
 * search_path, or they inherit the caller's RLS and reintroduce the class.
 */
CREATE OR REPLACE FUNCTION audit.policy_helper_risks()
RETURNS TABLE (function_name text, problem text)
LANGUAGE sql STABLE AS $$
  SELECT n.nspname || '.' || pr.proname,
         CASE WHEN NOT pr.prosecdef THEN 'SECURITY INVOKER: inherits the caller''s RLS'
              ELSE 'SECURITY DEFINER without a pinned search_path' END
    FROM pg_proc pr
    JOIN pg_namespace n ON n.oid = pr.pronamespace
   WHERE n.nspname = 'auth'
     AND pr.proname IN (
       'in_scope','has_permission','shares_project_with','can_read_project',
       'administers_user','can_see_organisation','can_see_org_membership',
       'viewer_side','permission_limit','decide','eligible_withdrawal_countersignatories'
     )
     AND (NOT pr.prosecdef
          OR pr.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(pr.proconfig) c WHERE c LIKE 'search_path=%'));
$$;

-- ---------------------------------------------------------------------------
-- 5. Declare what remains. Each of these is a place where the nested policy
--    filtering IS the intended fence -- you see the child only where you can
--    see the parent -- so a cross-user answer would be wrong, not missing.
-- ---------------------------------------------------------------------------
INSERT INTO rls_reference_declaration (on_table, policy_name, referenced_table, disposition, reason) VALUES
 ('alignment_equation','alignment_equation_select','alignment','pruning_intended',
  'A chainage equation is only meaningful with its alignment. Seeing equations for an alignment you cannot see would leak the design.'),
 ('alignment_equation','alignment_equation_write','alignment','pruning_intended',
  'Same fence on the write path.'),
 ('authentication_event','authentication_event_enrolment_evidence','device','pruning_intended',
  'Enrolment evidence is deliberately exposed only for devices the viewer can already read. The device policy IS the fence (0016).'),
 ('authentication_event','authentication_event_enrolment_evidence','device_user_enrolment','pruning_intended',
  'Same fence: the enrolment must itself be visible before the authentication behind it is.'),
 ('clause','clause_update','user_account','pruning_intended',
  'Self-lookup only (WHERE id = auth.user_id()), to attribute a tenant summary to the author''s own organisation. A row that is always visible cannot prune.'),
 ('contract_acceptance_work_type','cawt_select','contract','pruning_intended',
  'The nomination list is scoped by its contract; seeing it for a contract you cannot read would leak the acceptance regime.'),
 ('contract_acceptance_work_type','cawt_insert','contract','pruning_intended',
  'Same fence on the write path.'),
 ('device_user_enrolment','device_user_enrolment_select','device','pruning_intended',
  'You see who can unlock a device only where you can see the device. The device policy IS the fence.'),
 ('device_user_enrolment','device_user_enrolment_update','device','pruning_intended',
  'Same fence on the revoke path.');

-- Both detectors must be clean at the end of this migration, or the migration
-- itself has introduced the thing it exists to prevent.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s.%s -> %s', on_table, policy_name, referenced_table), '; ')
    INTO bad FROM audit.rls_reference_risks();
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_UNDECLARED_RLS_REFERENCE: %', bad;
  END IF;

  SELECT string_agg(format('%s (%s)', function_name, problem), '; ')
    INTO bad FROM audit.policy_helper_risks();
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_UNSAFE_POLICY_HELPER: %', bad;
  END IF;
END $$;
