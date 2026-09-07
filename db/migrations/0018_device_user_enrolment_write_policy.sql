-- 0018 — device_user_enrolment had no UPDATE policy, so revoking a person's
-- unlock silently affected zero rows.
--
-- Found by tests/devices-ui.test.ts. With RLS enabled and no permissive UPDATE
-- policy, Postgres does not raise — the UPDATE simply matches nothing. The
-- revoke action reported "not available, or already revoked" and the person
-- stayed able to unlock the tablet. A security control that fails silently is
-- worse than one that is absent, because the register showed it as done.
--
-- INSERT is deliberately still absent: a user enrolment is created only through
-- the path in migration 0002, which requires the USER'S OWN successful MFA event
-- (LOTLINE_USER_ENROLMENT_MISMATCH). There is no policy here that would let an
-- administrator create one.

CREATE POLICY device_user_enrolment_update ON device_user_enrolment
  FOR UPDATE TO lotline_app, lotline_worker
  USING (
    -- Anyone may retire their own unlock: the "I have lost my phone" case must
    -- not require finding an administrator.
    user_id = auth.user_id()
    OR EXISTS (
      SELECT 1 FROM device d
       WHERE d.id = device_user_enrolment.device_id
         AND d.project_id IS NOT NULL
         AND auth.in_scope('read', d.project_id)
    )
  )
  WITH CHECK (
    user_id = auth.user_id()
    OR EXISTS (
      SELECT 1 FROM device d
       WHERE d.id = device_user_enrolment.device_id
         AND d.project_id IS NOT NULL
         AND auth.in_scope('write', d.project_id)
         AND auth.has_permission('admin.device.revoke', d.project_id)
    )
  );

COMMENT ON POLICY device_user_enrolment_update ON device_user_enrolment IS
  'Retiring an unlock: your own, always; anyone else''s, only with admin.device.revoke on the device''s project. No INSERT policy exists -- an enrolment can only be created by the user''s own MFA (migration 0002).';
