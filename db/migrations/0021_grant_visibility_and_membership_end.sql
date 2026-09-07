-- 0021 — Two defects found by tests/people-ui.test.ts.
--
-- (1) access_grant's only policy was `user_id = auth.user_id()`, so any query
--     that asks "what scope does THIS OTHER PERSON hold" saw nothing. The people
--     screen could render only the viewer's own scopes — the same class of
--     failure as 0017, where an RLS-protected table referenced inside a query
--     silently prunes to the viewer's own rows.
--
--     Widened to exactly the people you can already see: auth.shares_project_with
--     is the same predicate that governs user_account, so grant visibility and
--     person visibility cannot drift apart. It is SECURITY DEFINER and
--     access_grant is NO FORCE, so the owner bypasses this policy when the
--     function evaluates — no recursion.
--
-- (2) Ending a membership granted TODAY produced daterange(today, today) — an
--     EMPTY range. Access lapses correctly, but `upper()` of an empty range is
--     null, so the record no longer showed when it ended, or that it ever
--     existed. The range is the gate; it is a poor place to also be the record.

DROP POLICY IF EXISTS access_grant_select ON access_grant;
CREATE POLICY access_grant_select ON access_grant
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (
    user_id = auth.user_id()
    OR auth.shares_project_with(user_id)
  );

COMMENT ON POLICY access_grant_select ON access_grant IS
  'You see the scopes of the people you can see. Shares the predicate with user_account so person visibility and grant visibility cannot drift.';

-- The gate stays the range; the record becomes explicit.
ALTER TABLE project_membership ADD COLUMN ended_at  timestamptz;
ALTER TABLE project_membership ADD COLUMN ended_by  uuid REFERENCES user_account(id);
ALTER TABLE project_membership ADD COLUMN end_reason text;

COMMENT ON COLUMN project_membership.ended_at IS
  'When this membership was deliberately ended. active_period remains the access gate, but a membership granted and ended on the same day yields an empty range whose upper bound is null — so the fact of the ending is recorded here rather than inferred from the gate.';

CREATE INDEX project_membership_ended ON project_membership (project_id, ended_at)
  WHERE ended_at IS NOT NULL;
