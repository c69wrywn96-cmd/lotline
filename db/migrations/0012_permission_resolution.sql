-- 0012 — Permission resolution.
--
-- 04-rls-and-enforcement.md §4 wrote `auth.has_permission(...)` into the policy
-- shape but the function was never built. This migration builds it, and makes
-- SQL the single authoritative implementation: the TypeScript can() calls this
-- function rather than reimplementing the rules, because two implementations of
-- an authorisation rule is one implementation and one latent divergence.
--
-- Resolution order (03-permission-matrix.md §9), steps 3–6 and the §10
-- authentication floor:
--   3. membership active
--   4. scope        -> auth.in_scope (0005)
--   5. permission held via role_permission, permission_grant or delegation
--   6. constraint satisfied
--  §10 authentication strength, and the device-bound capability intersection.
--
-- Steps 2 (row visibility), 7 (state machine guards) and 8 (signature
-- eligibility) are enforced by RLS and by the guard triggers, not here.

-- ---------------------------------------------------------------------------
-- Two more session GUCs: how strongly this session authenticated, and whether
-- it is running on a shared device.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.auth_strength() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(nullif(current_setting('app.auth_strength', true), ''), 'session')
$$;

CREATE OR REPLACE FUNCTION auth.device_bound() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(nullif(current_setting('app.device_bound', true), '')::boolean, false)
$$;

/** session < device_unlock < step_up */
CREATE OR REPLACE FUNCTION auth.strength_rank(p_strength text) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_strength
           WHEN 'session'       THEN 1
           WHEN 'device_unlock' THEN 2
           WHEN 'step_up'       THEN 3
           ELSE 0
         END
$$;

-- ---------------------------------------------------------------------------
-- Step 5: is the permission held at all, by any route?
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because resolution must consult project_membership and
-- org_membership rows the calling user cannot necessarily SELECT. Answering
-- "may I?" must not itself require permission to read the permission tables.
CREATE OR REPLACE FUNCTION auth.has_permission(p_code text, p_project_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT
    -- via a project-scoped role
    EXISTS (
      SELECT 1 FROM project_membership pm
      JOIN role_permission rp ON rp.role_id = pm.role_id
      WHERE pm.user_id    = auth.user_id()
        AND pm.project_id = p_project_id
        AND pm.active_period @> CURRENT_DATE
        AND rp.permission_code = p_code
    )
    -- via an organisation-scoped role (ADR-0023), on any project the
    -- organisation actively participates in
    OR EXISTS (
      SELECT 1 FROM org_membership om
      JOIN role_permission rp ON rp.role_id = om.role_id
      JOIN project_participant pp ON pp.organisation_id = om.organisation_id
      WHERE om.user_id = auth.user_id()
        AND om.role_id IS NOT NULL
        AND om.active_period @> CURRENT_DATE
        AND pp.project_id = p_project_id
        AND pp.active_period @> CURRENT_DATE
        AND rp.permission_code = p_code
    )
    -- via a time-boxed individual grant
    OR EXISTS (
      SELECT 1 FROM permission_grant pg
      WHERE pg.user_id = auth.user_id()
        AND pg.project_id = p_project_id
        AND pg.permission_code = p_code
        AND pg.valid_period @> now()
    )
    -- via an acting-for delegation. Non-delegable codes cannot reach a
    -- delegation row at all (0003 trigger), so no exclusion is needed here.
    OR EXISTS (
      SELECT 1 FROM delegation d
      WHERE d.to_user_id = auth.user_id()
        AND d.project_id = p_project_id
        AND d.valid_period @> now()
        AND p_code = ANY (d.permission_codes)
    );
$$;

-- ---------------------------------------------------------------------------
-- Step 6: numeric constraints. A user holding two roles takes the HIGHER
-- ceiling — holding an additional role must never reduce authority.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.permission_limit(
  p_code text, p_project_id uuid, p_key text
) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT max((rp.constraint_json ->> p_key)::numeric)
  FROM role_permission rp
  WHERE rp.permission_code = p_code
    AND rp.constraint_json ? p_key
    AND (
      rp.role_id IN (
        SELECT pm.role_id FROM project_membership pm
        WHERE pm.user_id = auth.user_id() AND pm.project_id = p_project_id
          AND pm.active_period @> CURRENT_DATE
      )
      OR rp.role_id IN (
        SELECT om.role_id FROM org_membership om
        JOIN project_participant pp ON pp.organisation_id = om.organisation_id
        WHERE om.user_id = auth.user_id() AND om.role_id IS NOT NULL
          AND om.active_period @> CURRENT_DATE
          AND pp.project_id = p_project_id AND pp.active_period @> CURRENT_DATE
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- The full decision, with a reason. Returning WHY a request was refused is what
-- lets the UI say "outside your assigned sections" rather than a blank denial —
-- and it is what makes the resolution order testable step by step.
-- ---------------------------------------------------------------------------
CREATE TYPE auth_decision AS (allowed boolean, reason text);

CREATE OR REPLACE FUNCTION auth.decide(
  p_code        text,
  p_project_id  uuid,
  p_kind        text    DEFAULT 'write',
  p_zone_path   ltree   DEFAULT NULL,
  p_wbs_path    ltree   DEFAULT NULL,
  p_package_id  uuid    DEFAULT NULL,
  p_supplier_id uuid    DEFAULT NULL
) RETURNS auth_decision
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  perm record;
BEGIN
  IF auth.user_id() IS NULL THEN
    RETURN ROW(false, 'no_identity')::auth_decision;
  END IF;

  SELECT * INTO perm FROM permission WHERE code = p_code;
  IF perm IS NULL THEN
    -- An unknown code is a programming error, and it fails closed.
    RETURN ROW(false, 'unknown_permission')::auth_decision;
  END IF;

  -- §10: a shared-device session is capability-restricted regardless of role.
  -- Checked before the permission itself so the reason is the useful one.
  IF auth.device_bound() AND NOT perm.device_bound_allowed THEN
    RETURN ROW(false, 'not_available_on_shared_device')::auth_decision;
  END IF;

  IF NOT auth.in_scope(p_kind, p_project_id, p_zone_path, p_wbs_path,
                       p_package_id, p_supplier_id) THEN
    -- Distinguishes "you can see it but it is not yours to change" from
    -- "it does not exist for you" (ADR-0020).
    IF p_kind = 'write' AND auth.in_scope('read', p_project_id, p_zone_path, p_wbs_path,
                                          p_package_id, p_supplier_id) THEN
      RETURN ROW(false, 'outside_write_scope')::auth_decision;
    END IF;
    RETURN ROW(false, 'out_of_scope')::auth_decision;
  END IF;

  IF NOT auth.has_permission(p_code, p_project_id) THEN
    RETURN ROW(false, 'permission_not_held')::auth_decision;
  END IF;

  IF auth.strength_rank(auth.auth_strength())
     < auth.strength_rank(perm.min_auth_strength) THEN
    RETURN ROW(false, 'step_up_required')::auth_decision;
  END IF;

  RETURN ROW(true, 'allowed')::auth_decision;
END $$;

CREATE OR REPLACE FUNCTION auth.can(
  p_code        text,
  p_project_id  uuid,
  p_kind        text    DEFAULT 'write',
  p_zone_path   ltree   DEFAULT NULL,
  p_wbs_path    ltree   DEFAULT NULL,
  p_package_id  uuid    DEFAULT NULL,
  p_supplier_id uuid    DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (auth.decide(p_code, p_project_id, p_kind, p_zone_path, p_wbs_path,
                      p_package_id, p_supplier_id)).allowed
$$;

GRANT EXECUTE ON FUNCTION auth.has_permission(text, uuid)          TO lotline_app, lotline_worker, lotline_readonly;
GRANT EXECUTE ON FUNCTION auth.permission_limit(text, uuid, text)  TO lotline_app, lotline_worker, lotline_readonly;
GRANT EXECUTE ON FUNCTION auth.decide(text, uuid, text, ltree, ltree, uuid, uuid) TO lotline_app, lotline_worker, lotline_readonly;
GRANT EXECUTE ON FUNCTION auth.can(text, uuid, text, ltree, ltree, uuid, uuid)    TO lotline_app, lotline_worker, lotline_readonly;

-- ---------------------------------------------------------------------------
-- Defence in depth on the write policies that matter most.
--
-- Deliberately NOT applied to every table: permission checking belongs in the
-- application layer (03-permission-matrix.md §9 places only steps 2, 7 and 8 in
-- the database), and an EXISTS-heavy predicate on every row of a 10,000-row
-- register would cost more than it buys. It IS applied where a mistake would be
-- unrecoverable: the tables that define who can do what.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS project_membership_insert ON project_membership;
CREATE POLICY project_membership_insert ON project_membership
  FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (auth.in_scope('write', project_id)
              AND auth.has_permission('admin.users.manage', project_id));

DROP POLICY IF EXISTS project_membership_update ON project_membership;
CREATE POLICY project_membership_update ON project_membership
  FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.in_scope('read', project_id))
  WITH CHECK (auth.in_scope('write', project_id)
              AND auth.has_permission('admin.users.manage', project_id));

DROP POLICY IF EXISTS contract_update ON contract;
CREATE POLICY contract_update ON contract
  FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.in_scope('read', project_id))
  WITH CHECK (auth.in_scope('write', project_id)
              AND auth.has_permission('admin.project.configure', project_id));

DROP POLICY IF EXISTS device_write ON device;
CREATE POLICY device_write ON device
  FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (project_id IS NOT NULL
              AND auth.in_scope('write', project_id)
              AND auth.has_permission('admin.device.enrol', project_id));
