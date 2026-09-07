-- 0013 — The access_grant projection is rebuilt per (user, project), not per
-- membership.
--
-- Defect found by tests/permissions.test.ts: a user holding TWO roles on one
-- project — an Engineering Manager acting as Construction Manager, which is
-- entirely normal cover — produced two identical write/project grants and
-- violated the primary key, so the second membership could not be created at
-- all.
--
-- Adding ON CONFLICT DO NOTHING per membership would have hidden the error and
-- introduced a worse one: the surviving row would carry only the FIRST
-- membership's source_id, so deactivating that membership would delete a grant
-- the second membership still required, silently removing access the user
-- legitimately held.
--
-- The projection is therefore computed for the whole (user, project) pair from
-- every active membership at once. Union semantics: more memberships can only
-- ever mean more access.

CREATE OR REPLACE FUNCTION auth.grants_rebuild(p_user_id uuid, p_project_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  m          record;
  r          record;
  sides      text[];
  wide_read  boolean := false;
BEGIN
  IF p_user_id IS NULL OR p_project_id IS NULL THEN RETURN; END IF;

  DELETE FROM access_grant WHERE user_id = p_user_id AND project_id = p_project_id;

  -- A user on both sides of one contract (a secondee) would collapse two
  -- different `side` values onto one primary key, and `side` drives the
  -- client/contractor UI shell split — so nobody would know which side they were
  -- signing on. ADR-0015 requires an explicit, audited context switch for that
  -- case; until it exists, surface the condition rather than picking one.
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

  -- ------------------------------------------------------------------
  -- Project-scoped memberships
  -- ------------------------------------------------------------------
  FOR m IN
    SELECT pm.*, ro.side, ro.grants_project_wide_read
      FROM project_membership pm
      JOIN role ro ON ro.id = pm.role_id
     WHERE pm.user_id = p_user_id AND pm.project_id = p_project_id
       AND pm.active_period @> CURRENT_DATE
     ORDER BY pm.created_at
  LOOP
    IF m.grants_project_wide_read THEN
      wide_read := true;
      INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                                scope_path, side, source, source_id)
      VALUES (p_user_id, p_project_id, 'read', 'project',
              '00000000-0000-0000-0000-000000000000'::uuid, NULL, m.side,
              'project_membership', m.id)
      ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                                scope_path, side, source, source_id)
      VALUES (p_user_id, p_project_id, 'read', m.read_scope_type,
              COALESCE(m.read_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
              auth.scope_path_for(m.read_scope_type, m.read_scope_id), m.side,
              'project_membership', m.id)
      ON CONFLICT DO NOTHING;
    END IF;

    IF m.write_scope_type <> 'none' THEN
      INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                                scope_path, side, source, source_id)
      VALUES (p_user_id, p_project_id, 'write', m.write_scope_type,
              COALESCE(m.write_scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
              auth.scope_path_for(m.write_scope_type, m.write_scope_id), m.side,
              'project_membership', m.id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- ------------------------------------------------------------------
  -- Organisation-scoped memberships (ADR-0023)
  -- ------------------------------------------------------------------
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
                              scope_path, side, source, source_id)
    VALUES (p_user_id, p_project_id, 'read', 'project',
            '00000000-0000-0000-0000-000000000000'::uuid, NULL, m.side,
            'org_membership', m.id)
    ON CONFLICT DO NOTHING;

    INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, scope_id,
                              scope_path, side, source, source_id)
    VALUES (p_user_id, p_project_id, 'write', 'project',
            '00000000-0000-0000-0000-000000000000'::uuid, NULL, m.side,
            'org_membership', m.id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Triggers now rebuild the pair, and cover the case where a membership is
-- re-pointed at a different user or project.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.tg_project_membership_grants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM auth.grants_rebuild(OLD.user_id, OLD.project_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM auth.grants_rebuild(NEW.user_id, NEW.project_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION auth.tg_org_membership_grants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT DISTINCT pp.project_id
      FROM project_participant pp
     WHERE pp.organisation_id IN (COALESCE(NEW.organisation_id, OLD.organisation_id),
                                  COALESCE(OLD.organisation_id, NEW.organisation_id))
  LOOP
    IF TG_OP <> 'INSERT' THEN PERFORM auth.grants_rebuild(OLD.user_id, p.project_id); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM auth.grants_rebuild(NEW.user_id, p.project_id); END IF;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION auth.tg_participant_grants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE u record;
BEGIN
  FOR u IN
    SELECT DISTINCT om.user_id
      FROM org_membership om
     WHERE om.organisation_id = COALESCE(NEW.organisation_id, OLD.organisation_id)
       AND om.role_id IS NOT NULL
  LOOP
    PERFORM auth.grants_rebuild(u.user_id, COALESCE(NEW.project_id, OLD.project_id));
  END LOOP;
  RETURN NULL;
END $$;

-- The per-membership entry points are retained as thin wrappers so nothing that
-- referenced them breaks, but they now delegate to the pair rebuild.
CREATE OR REPLACE FUNCTION auth.project_grants_rebuild(p_membership_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE m record;
BEGIN
  SELECT * INTO m FROM project_membership WHERE id = p_membership_id;
  IF m IS NULL THEN RETURN; END IF;
  PERFORM auth.grants_rebuild(m.user_id, m.project_id);
END $$;

CREATE OR REPLACE FUNCTION auth.org_grants_rebuild(p_membership_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE m record; p record;
BEGIN
  SELECT * INTO m FROM org_membership WHERE id = p_membership_id;
  IF m IS NULL THEN RETURN; END IF;
  FOR p IN SELECT project_id FROM project_participant WHERE organisation_id = m.organisation_id
  LOOP
    PERFORM auth.grants_rebuild(m.user_id, p.project_id);
  END LOOP;
END $$;

-- Rebuild everything once, so an existing database converges on the new logic.
DO $$
DECLARE pair record;
BEGIN
  FOR pair IN
    SELECT DISTINCT user_id, project_id FROM project_membership
    UNION
    SELECT DISTINCT om.user_id, pp.project_id
      FROM org_membership om
      JOIN project_participant pp ON pp.organisation_id = om.organisation_id
     WHERE om.role_id IS NOT NULL
  LOOP
    PERFORM auth.grants_rebuild(pair.user_id, pair.project_id);
  END LOOP;
END $$;
