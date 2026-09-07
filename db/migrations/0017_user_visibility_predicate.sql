-- 0017 — user_account visibility was effectively self-only.
--
-- Defect found by tests/devices-ui.test.ts. The user_account SELECT policy asked
-- "does this person share a project with me?" by joining access_grant to itself:
--
--   EXISTS (SELECT 1 FROM access_grant mine
--             JOIN access_grant theirs ON theirs.project_id = mine.project_id
--                                     AND theirs.user_id = user_account.id
--            WHERE mine.user_id = auth.user_id())
--
-- but access_grant carries its own policy (user_id = auth.user_id()), and RLS
-- applies to tables referenced INSIDE a policy predicate as well. So `theirs`
-- could only ever resolve to the viewer's own rows, and the whole EXISTS reduced
-- to `user_account.id = auth.user_id()`.
--
-- The consequence was not limited to the device screen: no register could render
-- another person's name. A signatory, a responsible engineer, an enrolled user —
-- all invisible. It failed silently, as an empty join rather than an error,
-- which is why it survived until a screen needed to display someone else.
--
-- The fix is a SECURITY DEFINER predicate that can evaluate the shared-project
-- question over the whole projection and returns only a boolean. It leaks no
-- rows: the caller learns "yes, we share a project", never which grants exist.

CREATE OR REPLACE FUNCTION auth.shares_project_with(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1
      FROM access_grant mine
      JOIN access_grant theirs ON theirs.project_id = mine.project_id
     WHERE mine.user_id   = auth.user_id()
       AND theirs.user_id = p_user_id
  );
$$;
GRANT EXECUTE ON FUNCTION auth.shares_project_with(uuid)
  TO lotline_app, lotline_worker, lotline_readonly;

DROP POLICY IF EXISTS user_account_select ON user_account;
CREATE POLICY user_account_select ON user_account
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (
    id = auth.user_id()
    OR auth.shares_project_with(id)
  );

-- organisation had the same shape of bug: its policy joined project_participant
-- to access_grant, and access_grant's own policy pruned the join to the viewer's
-- rows. That one happened to still work — the viewer's own grant is what
-- matters there — but it is fragile for the same reason, so it gets the same
-- treatment.
CREATE OR REPLACE FUNCTION auth.can_read_project(p_project_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM access_grant g
     WHERE g.user_id = auth.user_id() AND g.project_id = p_project_id
       AND g.grant_kind = 'read'
  );
$$;
GRANT EXECUTE ON FUNCTION auth.can_read_project(uuid)
  TO lotline_app, lotline_worker, lotline_readonly;

DROP POLICY IF EXISTS organisation_select ON organisation;
CREATE POLICY organisation_select ON organisation
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (
    EXISTS (
      SELECT 1 FROM project_participant pp
       WHERE pp.organisation_id = organisation.id
         AND auth.can_read_project(pp.project_id)
    )
    OR id = (SELECT primary_org_id FROM user_account WHERE id = auth.user_id())
  );
