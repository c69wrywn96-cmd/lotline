-- 0019 — Fixing user visibility WITHOUT dropping the external fence.
--
-- 0017 replaced a broken self-referential predicate with auth.shares_project_with,
-- which restored the ability to render a signatory's name. But "shares a project"
-- is too coarse: two subcontractors on the same project share it, so Vellacott
-- could see Rowe's people. That violates the rule that subcontractors and
-- suppliers must never see another sub's data — enforced at the query layer, not
-- in the UI.
--
-- The correct rule:
--   * A contractor-, client- or verifier-side viewer sees everyone on their
--     projects. They have to: they manage the supply chain.
--   * An external viewer (subcontractor, supplier) sees the non-external people
--     on their projects — they need the head contractor's engineers and the
--     Superintendent who released their hold point — plus their OWN
--     organisation. They never see another external organisation.
--
-- The comparison is made entirely within access_grant, which is why
-- subject_org_id is added here: reading user_account from inside a SECURITY
-- DEFINER predicate would depend on the function owner being able to bypass
-- user_account's own FORCE row security, which is true of a superuser owner in
-- development and NOT true of the non-superuser owner used in production.

ALTER TABLE access_grant ADD COLUMN subject_org_id uuid REFERENCES organisation(id);
COMMENT ON COLUMN access_grant.subject_org_id IS
  'The granted user''s organisation, denormalised at projection time so cross-organisation visibility can be decided without reading user_account from inside a policy predicate.';

CREATE OR REPLACE FUNCTION auth.grants_rebuild(p_user_id uuid, p_project_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  m         record;
  sides     text[];
  org_id    uuid;
BEGIN
  IF p_user_id IS NULL OR p_project_id IS NULL THEN RETURN; END IF;

  DELETE FROM access_grant WHERE user_id = p_user_id AND project_id = p_project_id;

  SELECT primary_org_id INTO org_id FROM user_account WHERE id = p_user_id;

  SELECT array_agg(DISTINCT ro.side) INTO sides
  FROM (
    SELECT pm.role_id FROM project_membership pm
     WHERE pm.user_id = p_user_id AND pm.project_id = p_project_id
       AND pm.active_period @> CURRENT_DATE
    UNION ALL
    SELECT om.role_id FROM org_membership om
     JOIN project_participant pp ON pp.organisation_id = om.organisation_id
    WHERE om.user_id = p_user_id AND om.role_id IS NOT NULL
      AND om.active_period @> CURRENT_DATE
      AND pp.project_id = p_project_id AND pp.active_period @> CURRENT_DATE
  ) held
  JOIN role ro ON ro.id = held.role_id;

  IF array_length(sides, 1) > 1 THEN
    RAISE EXCEPTION
      'LOTLINE_SIDE_CONFLICT: user % holds roles on both sides of project % (%). A single identity cannot act as contractor and client on one project.',
      p_user_id, p_project_id, array_to_string(sides, ' + ');
  END IF;

  FOR m IN
    SELECT pm.*, ro.side, ro.grants_project_wide_read
      FROM project_membership pm
      JOIN role ro ON ro.id = pm.role_id
     WHERE pm.user_id = p_user_id AND pm.project_id = p_project_id
       AND pm.active_period @> CURRENT_DATE
     ORDER BY pm.created_at
  LOOP
    IF m.grants_project_wide_read THEN
      INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                                scope_path, side, source, source_id, subject_org_id)
      VALUES (p_user_id, p_project_id, 'read', 'project',
              '00000000-0000-0000-0000-000000000000'::uuid, NULL, m.side,
              'project_membership', m.id, org_id)
      ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                                scope_path, side, source, source_id, subject_org_id)
      VALUES (p_user_id, p_project_id, 'read', m.read_scope_type,
              COALESCE(m.read_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
              auth.scope_path_for(m.read_scope_type, m.read_scope_id), m.side,
              'project_membership', m.id, org_id)
      ON CONFLICT DO NOTHING;
    END IF;

    IF m.write_scope_type <> 'none' THEN
      INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                                scope_path, side, source, source_id, subject_org_id)
      VALUES (p_user_id, p_project_id, 'write', m.write_scope_type,
              COALESCE(m.write_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
              auth.scope_path_for(m.write_scope_type, m.write_scope_id), m.side,
              'project_membership', m.id, org_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  FOR m IN
    SELECT om.id, ro.side
      FROM org_membership om
      JOIN role ro ON ro.id = om.role_id
      JOIN project_participant pp ON pp.organisation_id = om.organisation_id
     WHERE om.user_id = p_user_id AND om.role_id IS NOT NULL
       AND om.active_period @> CURRENT_DATE
       AND pp.project_id = p_project_id
       AND pp.active_period @> CURRENT_DATE
       AND ro.side <> 'external'
     ORDER BY om.created_at
  LOOP
    INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                              scope_path, side, source, source_id, subject_org_id)
    VALUES (p_user_id, p_project_id, 'read', 'project',
            '00000000-0000-0000-0000-000000000000'::uuid, NULL, m.side,
            'org_membership', m.id, org_id)
    ON CONFLICT DO NOTHING;

    INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                              scope_path, side, source, source_id, subject_org_id)
    VALUES (p_user_id, p_project_id, 'write', 'project',
            '00000000-0000-0000-0000-000000000000'::uuid, NULL, m.side,
            'org_membership', m.id, org_id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- Visibility of PEOPLE, with the external fence intact.
CREATE OR REPLACE FUNCTION auth.shares_project_with(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1
      FROM access_grant mine
      JOIN access_grant theirs ON theirs.project_id = mine.project_id
     WHERE mine.user_id   = auth.user_id()
       AND theirs.user_id = p_user_id
       AND (
             mine.side   <> 'external'          -- contractor/client/verifier see all
          OR theirs.side <> 'external'          -- externals see the delivery team
          OR mine.subject_org_id IS NOT DISTINCT FROM theirs.subject_org_id  -- own org
       )
  );
$$;

CREATE OR REPLACE FUNCTION auth.viewer_side(p_project_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT side FROM access_grant
   WHERE user_id = auth.user_id() AND project_id = p_project_id
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION auth.viewer_side(uuid) TO lotline_app, lotline_worker, lotline_readonly;

-- Visibility of ORGANISATIONS, same fence: a subcontractor sees the delivery
-- team's organisations and their own, never a competitor's.
DROP POLICY IF EXISTS organisation_select ON organisation;
CREATE POLICY organisation_select ON organisation
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (
    id = (SELECT primary_org_id FROM user_account WHERE id = auth.user_id())
    OR EXISTS (
      SELECT 1 FROM project_participant pp
       WHERE pp.organisation_id = organisation.id
         AND auth.can_read_project(pp.project_id)
         AND (
           auth.viewer_side(pp.project_id) <> 'external'
           OR pp.participation NOT IN ('subcontractor','supplier')
         )
    )
  );

-- Backfill subject_org_id on every existing grant.
DO $$
DECLARE pair record;
BEGIN
  FOR pair IN SELECT DISTINCT user_id, project_id FROM access_grant LOOP
    PERFORM auth.grants_rebuild(pair.user_id, pair.project_id);
  END LOOP;
END $$;
