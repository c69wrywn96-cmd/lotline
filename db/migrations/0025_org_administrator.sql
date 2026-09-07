-- 0025 — Organisation-scoped Administrator: the counter-signatory of last
-- resort.
--
-- "Nobody can grant themselves a role" is correct, and it creates the same
-- deadlock as the withdrawal counter-signature: a tenant whose only
-- administrator leaves, or a two-person QA team where the second person is the
-- one who needs correcting, has no exit and no self-service route back in. The
-- shape has now appeared twice, so it gets a structural answer rather than a
-- second special case.
--
-- ORGADMIN is authority to UNSTICK PEOPLE, not authority to do the work. It
-- cannot sign checkpoints, release hold points, or certify conformance -- and
-- that is enforced and tested, not merely intended, because a role that
-- accumulates permissions quietly becomes the superuser this is designed not to
-- be.

INSERT INTO permission (code, resource, action, description, min_auth_strength, device_bound_allowed)
VALUES ('admin.role_grant.countersign','admin','role_grant.countersign',
        'Counter-sign a role grant where no eligible second person exists on the project',
        'step_up', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role (code, name, side, scope_level, is_system_template, grants_project_wide_read)
VALUES ('ORGADMIN','Organisation Administrator','contractor','organisation',true,true);

SELECT public.grant_role('ORGADMIN',
  -- Unsticking people:
  'admin.users.manage',
  'admin.roles.manage',
  'admin.permission_grant.issue',
  'admin.identity_link.initiate',
  'admin.device.revoke',
  'signature.withdraw.countersign',
  'checkpoint.correct.countersign',
  'admin.role_grant.countersign',
  -- Seeing the estate they administer:
  'lot.view','itp.master.view','itp.instance.view','export.audit_log');

-- ---------------------------------------------------------------------------
-- Not a superuser. Asserted, not assumed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.org_role_privilege_risks()
RETURNS TABLE (role_code text, permission_code text)
LANGUAGE sql STABLE AS $$
  SELECT r.code, rp.permission_code
    FROM role r
    JOIN role_permission rp ON rp.role_id = r.id
   WHERE r.scope_level = 'organisation'
     AND rp.permission_code IN (
       -- Doing the work, as opposed to unsticking the people who do it.
       'checkpoint.sign',
       'checkpoint.hold.release',
       'checkpoint.hold.release.retrospective',
       'lot.certify_conformance',
       'lot.accept',
       'lot.raise',
       'concession.approve.em',
       'concession.approve.client',
       'pc.sign'
     );
$$;
COMMENT ON FUNCTION audit.org_role_privilege_risks IS
  'Organisation-scoped roles holding permissions that DO the work rather than unstick the people doing it. Must be empty: a group appointment is not a project nomination.';

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(role_code || '.' || permission_code, ', ')
    INTO bad FROM audit.org_role_privilege_risks();
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_ORG_ROLE_OVERREACH: %', bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- At least two, and the last one cannot be removed.
-- ---------------------------------------------------------------------------
-- Two, not one: an organisation with a single administrator is one resignation
-- away from the deadlock this role exists to prevent, and the second
-- administrator is also who counter-signs the first.
CREATE OR REPLACE FUNCTION auth.count_org_administrators(p_org_id uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT count(DISTINCT om.user_id)::int
    FROM org_membership om
    JOIN role r ON r.id = om.role_id
   WHERE om.organisation_id = p_org_id
     AND r.code = 'ORGADMIN' AND r.owner_org_id IS NULL
     AND om.active_period @> CURRENT_DATE;
$$;
GRANT EXECUTE ON FUNCTION auth.count_org_administrators(uuid) TO lotline_app, lotline_worker;

CREATE OR REPLACE FUNCTION auth.assert_org_admin_floor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_org      uuid;
  was_admin  boolean;
  now_admin  boolean;
  remaining  int;
BEGIN
  v_org := COALESCE(OLD.organisation_id, NEW.organisation_id);

  SELECT EXISTS (SELECT 1 FROM role r WHERE r.id = OLD.role_id AND r.code = 'ORGADMIN'
                   AND r.owner_org_id IS NULL)
         AND OLD.active_period @> CURRENT_DATE
    INTO was_admin;

  IF TG_OP = 'DELETE' THEN
    now_admin := false;
  ELSE
    SELECT EXISTS (SELECT 1 FROM role r WHERE r.id = NEW.role_id AND r.code = 'ORGADMIN'
                     AND r.owner_org_id IS NULL)
           AND NEW.active_period @> CURRENT_DATE
      INTO now_admin;
  END IF;

  -- Only a transition OUT of active administrator can breach the floor.
  IF NOT was_admin OR now_admin THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(DISTINCT om.user_id)::int INTO remaining
    FROM org_membership om
    JOIN role r ON r.id = om.role_id
   WHERE om.organisation_id = v_org
     AND r.code = 'ORGADMIN' AND r.owner_org_id IS NULL
     AND om.active_period @> CURRENT_DATE
     AND om.id <> OLD.id;

  IF remaining < 2 THEN
    RAISE EXCEPTION
      'LOTLINE_ORG_ADMIN_FLOOR: an organisation must keep at least two active administrators; removing this one would leave %. Appoint a replacement first.',
      remaining;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER org_admin_floor
  BEFORE UPDATE OR DELETE ON org_membership
  FOR EACH ROW EXECUTE FUNCTION auth.assert_org_admin_floor();

/** Tenants not meeting the floor. Surfaced rather than silently tolerated. */
CREATE OR REPLACE VIEW audit.org_admin_compliance AS
  SELECT o.id AS organisation_id, o.legal_name,
         auth.count_org_administrators(o.id) AS administrator_count,
         auth.count_org_administrators(o.id) >= 2 AS compliant
    FROM organisation o
   WHERE o.is_tenant;

-- ---------------------------------------------------------------------------
-- Every use of the org-level path is logged DISTINCTLY.
-- ---------------------------------------------------------------------------
-- If this is happening weekly, the project's role structure is wrong, and the
-- Quality Manager should be able to see that without reading the audit log line
-- by line. An escalation that looks the same as an ordinary counter-signature
-- teaches nobody anything.
CREATE TABLE escalation_event (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id     uuid        REFERENCES project(id),
  organisation_id uuid       NOT NULL REFERENCES organisation(id),
  kind           text        NOT NULL
                 CHECK (kind IN ('signature_withdrawal_countersign',
                                 'checkpoint_correction_countersign',
                                 'role_grant_countersign')),
  subject_type   text        NOT NULL,
  subject_id     uuid,
  actor_user_id  uuid        NOT NULL REFERENCES user_account(id),
  via_role_code  text        NOT NULL,
  reason         text        NOT NULL,
  -- Why no project-level route was available. The whole point of the record.
  no_project_route_reason text NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalation_event_project ON escalation_event (project_id, occurred_at DESC);
CREATE INDEX escalation_event_org ON escalation_event (organisation_id, occurred_at DESC);

ALTER TABLE escalation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_event FORCE ROW LEVEL SECURITY;
CREATE POLICY escalation_event_select ON escalation_event
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (project_id IS NOT NULL AND auth.in_scope('read', project_id));

REVOKE UPDATE, DELETE ON escalation_event FROM lotline_app, lotline_worker, lotline_readonly;
SELECT audit.attach('escalation_event');

/** How often the org-level path is being used, per project. */
CREATE OR REPLACE VIEW audit.escalation_frequency AS
  SELECT project_id, kind,
         count(*) FILTER (WHERE occurred_at > now() - interval '30 days')  AS last_30_days,
         count(*) FILTER (WHERE occurred_at > now() - interval '90 days')  AS last_90_days,
         max(occurred_at) AS most_recent
    FROM escalation_event
   GROUP BY project_id, kind;

-- ---------------------------------------------------------------------------
-- The counter-signatory resolver now includes organisation administrators.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.eligible_withdrawal_countersignatories(
  p_project_id         uuid,
  p_original_signatory uuid
) RETURNS TABLE (user_id uuid, via text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT pm.user_id, 'project'::text
    FROM project_membership pm
    JOIN role_permission rp ON rp.role_id = pm.role_id
   WHERE pm.project_id = p_project_id
     AND pm.active_period @> CURRENT_DATE
     AND rp.permission_code = 'signature.withdraw'
     AND pm.user_id <> p_original_signatory
  UNION
  SELECT om.user_id, 'organisation'::text
    FROM org_membership om
    JOIN role_permission rp ON rp.role_id = om.role_id
    JOIN project_participant pp ON pp.organisation_id = om.organisation_id
   WHERE pp.project_id = p_project_id
     AND pp.active_period @> CURRENT_DATE
     AND om.active_period @> CURRENT_DATE
     AND rp.permission_code = 'signature.withdraw.countersign'
     AND om.user_id <> p_original_signatory;
$$;

/** Who can counter-sign a role grant, and by what route. */
CREATE OR REPLACE FUNCTION auth.eligible_role_grant_countersignatories(
  p_project_id uuid,
  p_requester  uuid
) RETURNS TABLE (user_id uuid, via text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT pm.user_id, 'project'::text
    FROM project_membership pm
    JOIN role_permission rp ON rp.role_id = pm.role_id
   WHERE pm.project_id = p_project_id
     AND pm.active_period @> CURRENT_DATE
     AND rp.permission_code = 'admin.users.manage'
     AND pm.user_id <> p_requester
  UNION
  SELECT om.user_id, 'organisation'::text
    FROM org_membership om
    JOIN role_permission rp ON rp.role_id = om.role_id
    JOIN project_participant pp ON pp.organisation_id = om.organisation_id
   WHERE pp.project_id = p_project_id
     AND pp.active_period @> CURRENT_DATE
     AND om.active_period @> CURRENT_DATE
     AND rp.permission_code = 'admin.role_grant.countersign'
     AND om.user_id <> p_requester;
$$;
GRANT EXECUTE ON FUNCTION auth.eligible_role_grant_countersignatories(uuid, uuid)
  TO lotline_app, lotline_worker;

/**
 * Records a use of the organisation-level path. Refuses unless a project-level
 * route genuinely does not exist -- otherwise the escalation route quietly
 * becomes the ordinary route, and the frequency report stops meaning anything.
 */
CREATE OR REPLACE FUNCTION auth.record_escalation(
  p_project_id   uuid,
  p_kind         text,
  p_subject_type text,
  p_subject_id   uuid,
  p_reason       text,
  p_excluded_user uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_org       uuid;
  v_role      text;
  v_project_routes int;
  v_id        uuid;
BEGIN
  SELECT primary_org_id INTO v_org FROM user_account WHERE id = auth.user_id();

  SELECT r.code INTO v_role
    FROM org_membership om JOIN role r ON r.id = om.role_id
   WHERE om.user_id = auth.user_id() AND om.active_period @> CURRENT_DATE
     AND r.scope_level = 'organisation'
   LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'LOTLINE_NOT_ORG_ESCALATION: the caller holds no organisation-scoped role';
  END IF;

  SELECT count(*)::int INTO v_project_routes
    FROM auth.eligible_role_grant_countersignatories(p_project_id, p_excluded_user)
   WHERE via = 'project';

  IF p_kind = 'role_grant_countersign' AND v_project_routes > 0 THEN
    RAISE EXCEPTION
      'LOTLINE_PROJECT_ROUTE_AVAILABLE: % project-level administrators can do this. The organisation route is for when none can.',
      v_project_routes;
  END IF;

  INSERT INTO escalation_event
    (project_id, organisation_id, kind, subject_type, subject_id, actor_user_id,
     via_role_code, reason, no_project_route_reason)
  VALUES
    (p_project_id, v_org, p_kind, p_subject_type, p_subject_id, auth.user_id(),
     v_role, p_reason,
     format('no eligible project-level counter-signatory (excluding %s)', p_excluded_user))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION auth.record_escalation(uuid, text, text, uuid, text, uuid)
  TO lotline_app, lotline_worker;
