-- 0009 — Package-aware policy for subcontract_package.
--
-- 0007 gave this table the generic project-scoped policy, which asks
-- auth.in_scope('read', project_id) with no package argument. A subcontractor's
-- grant is scope_type='package', so that predicate is false for them and they
-- could not see their OWN package — the row that anchors their entire scope.
--
-- The fix passes the row's own id as the package argument, so a package-scoped
-- grant matches itself while a project-scoped grant continues to match
-- everything. The fence is unchanged: a subcontractor still matches only the one
-- package their grant names, which tests/rls.test.ts asserts in both directions.

DROP POLICY IF EXISTS subcontract_package_select ON subcontract_package;
DROP POLICY IF EXISTS subcontract_package_insert ON subcontract_package;
DROP POLICY IF EXISTS subcontract_package_update ON subcontract_package;

CREATE POLICY subcontract_package_select ON subcontract_package
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (auth.in_scope('read', project_id, NULL, NULL, id, NULL));

-- Creating and amending a package is head-contractor work: a package-scoped
-- grant deliberately does not satisfy this, because a subcontractor must not be
-- able to widen their own scope.
CREATE POLICY subcontract_package_insert ON subcontract_package
  FOR INSERT TO lotline_app, lotline_worker
  WITH CHECK (auth.in_scope('write', project_id));

CREATE POLICY subcontract_package_update ON subcontract_package
  FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.in_scope('read', project_id, NULL, NULL, id, NULL))
  WITH CHECK (auth.in_scope('write', project_id));
