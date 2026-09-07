-- 0016 — A supervisor must be able to see who can unlock their site tablet.
--
-- Defect found by tests/devices-ui.test.ts. authentication_event's only policy
-- was `user_id = auth.user_id()`, so the device detail screen's join onto the
-- binding authentication dropped every row that was not the viewer's own: a
-- Quality Manager looking at a shared tablet saw ZERO enrolled users. That is
-- the opposite of what the screen exists for — the whole point is that a
-- supervisor can see who is currently able to sign on that device, and that each
-- unlock is anchored to that person's own multi-factor login.
--
-- The fix is deliberately narrow. It exposes an authentication event ONLY where
-- that event is the anchor of a device enrolment on a device the viewer can
-- already read. A user's ordinary logins remain private to them: this is not
-- "supervisors can see everyone's authentication history", it is "the evidence
-- backing an enrolment is visible wherever the enrolment is".

CREATE POLICY authentication_event_enrolment_evidence ON authentication_event
  FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
  USING (
    -- The event anchors a user's unlock on a readable device.
    EXISTS (
      SELECT 1
        FROM device_user_enrolment due
        JOIN device d ON d.id = due.device_id
       WHERE due.enrolment_auth_event_id = authentication_event.id
         AND d.project_id IS NOT NULL
         AND auth.in_scope('read', d.project_id)
    )
    -- ...or the event anchors the trust of the device itself.
    OR EXISTS (
      SELECT 1 FROM device d
       WHERE d.enrolment_auth_event_id = authentication_event.id
         AND d.project_id IS NOT NULL
         AND auth.in_scope('read', d.project_id)
    )
  );

COMMENT ON POLICY authentication_event_enrolment_evidence ON authentication_event IS
  'Exposes an authentication event only where it is the anchor of a device or user enrolment on a readable device. Ordinary sign-in history stays private to the user.';
