-- 0027 — Hold point blocking and the checkpoint state machine.
--
-- Acceptance criterion §12.4 asks for proof that checkpoint 6 cannot be actioned
-- while checkpoint 5 (a hold) is unreleased. The proof is a database constraint,
-- reachable from psql. No role, permission, flag or environment variable
-- suppresses it.
--
-- Clearance is a RECORD, not a flag: the trigger asks whether a signed
-- hold_release row exists. That is what accommodates the two legitimate late
-- paths -- retrospective release and checkpoint correction -- without an
-- override switch (ADR-0010, ADR-0019).

-- ---------------------------------------------------------------------------
-- Is this checkpoint cleared?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.itp_checkpoint_cleared(p_checkpoint_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM hold_release hr
     WHERE hr.itp_checkpoint_id = p_checkpoint_id
       AND hr.signature_id     IS NOT NULL
       AND hr.superseded_by_id IS NULL
  )
  OR EXISTS (
    -- Marked not applicable under guard C8, which has its own authority and
    -- client-acknowledgement requirements.
    SELECT 1 FROM itp_checkpoint c
     WHERE c.id = p_checkpoint_id AND c.state = 'not_applicable'
  );
$$;

-- ---------------------------------------------------------------------------
-- The blocking predecessor, if any.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.itp_blocking_predecessor(p_checkpoint_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT c.id
    FROM itp_checkpoint c
    JOIN itp_checkpoint target ON target.id = p_checkpoint_id
   WHERE c.itp_instance_id  = target.itp_instance_id
     AND c.sequence_no      < target.sequence_no
     -- Witness, surveillance, review and record NEVER block. Filtered here as
     -- well as constrained on the table, so the behaviour survives the
     -- constraint being dropped.
     AND c.checkpoint_type  = 'hold'
     AND c.blocking_scope   = 'all_subsequent'
     AND c.superseded_by_id IS NULL      -- a corrected checkpoint is not a predecessor
     AND NOT public.itp_checkpoint_cleared(c.id)
   ORDER BY c.sequence_no
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Where the block is applied
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_not_blocked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE blocker uuid; blocker_seq int;
BEGIN
  -- Marking a checkpoint not applicable (C8) or failed is permitted while
  -- blocked; both have their own guards and neither is progress.
  IF TG_OP = 'UPDATE' AND NEW.state IN ('not_applicable','failed') THEN
    RETURN NEW;
  END IF;
  -- A state that is not advancing is not progression.
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  blocker := public.itp_blocking_predecessor(NEW.id);
  IF blocker IS NOT NULL THEN
    SELECT sequence_no INTO blocker_seq FROM itp_checkpoint WHERE id = blocker;
    RAISE EXCEPTION
      'LOTLINE_HOLD_POINT_BLOCKED: checkpoint % cannot proceed while the hold point at sequence % is unreleased',
      NEW.sequence_no, blocker_seq;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER itp_checkpoint_blocked
  BEFORE UPDATE ON itp_checkpoint
  FOR EACH ROW EXECUTE FUNCTION public.assert_not_blocked();

-- Evidence cannot be pre-loaded against a blocked checkpoint to make the block
-- look released.
CREATE OR REPLACE FUNCTION public.assert_evidence_not_blocked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE blocker uuid; blocker_seq int; target_seq int;
BEGIN
  blocker := public.itp_blocking_predecessor(NEW.itp_checkpoint_id);
  IF blocker IS NOT NULL THEN
    SELECT sequence_no INTO blocker_seq FROM itp_checkpoint WHERE id = blocker;
    SELECT sequence_no INTO target_seq  FROM itp_checkpoint WHERE id = NEW.itp_checkpoint_id;
    RAISE EXCEPTION
      'LOTLINE_HOLD_POINT_BLOCKED: evidence cannot be attached to checkpoint % while the hold point at sequence % is unreleased',
      target_seq, blocker_seq;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER checkpoint_evidence_blocked
  BEFORE INSERT ON checkpoint_evidence
  FOR EACH ROW EXECUTE FUNCTION public.assert_evidence_not_blocked();

-- ---------------------------------------------------------------------------
-- Who may release, and how
-- ---------------------------------------------------------------------------
-- The permission is necessary but not sufficient: the signer's active role must
-- be the checkpoint's nominated release_role_id, and their side must match the
-- checkpoint's responsible_party. A contractor cannot release a client hold
-- point. This holds IDENTICALLY for a retrospective release -- lateness never
-- relaxes who may sign (ADR-0019).
CREATE OR REPLACE FUNCTION auth.may_release_hold(p_checkpoint_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1
      FROM itp_checkpoint c
      JOIN itp_instance i ON i.id = c.itp_instance_id
      JOIN lot l          ON l.id = i.lot_id
      JOIN project_membership pm ON pm.user_id = p_user_id
                                AND pm.project_id = l.project_id
                                AND pm.active_period @> CURRENT_DATE
      JOIN role r ON r.id = pm.role_id
     WHERE c.id = p_checkpoint_id
       AND r.id = c.release_role_id
       AND CASE c.responsible_party
             WHEN 'client'   THEN r.side = 'client'
             WHEN 'verifier' THEN r.side = 'verifier'
             ELSE r.side IN ('contractor','external')
           END
  );
$$;
GRANT EXECUTE ON FUNCTION auth.may_release_hold(uuid, uuid) TO lotline_app, lotline_worker;

CREATE OR REPLACE FUNCTION public.assert_release_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE sig record; cp record;
BEGIN
  SELECT * INTO cp FROM itp_checkpoint WHERE id = NEW.itp_checkpoint_id;
  IF cp.checkpoint_type <> 'hold' THEN
    RAISE EXCEPTION 'LOTLINE_NOT_A_HOLD_POINT: only a hold point is released';
  END IF;

  SELECT * INTO sig FROM signature WHERE id = NEW.signature_id;
  IF sig IS NULL THEN
    RAISE EXCEPTION 'LOTLINE_RELEASE_UNSIGNED';
  END IF;
  IF sig.user_id <> NEW.released_by THEN
    RAISE EXCEPTION 'LOTLINE_RELEASE_SIGNATURE_MISMATCH: the signature belongs to another user';
  END IF;
  -- Releasing a hold point is step-up work, on every kind.
  IF sig.auth_strength <> 'step_up' THEN
    RAISE EXCEPTION
      'LOTLINE_RELEASE_STEP_UP_REQUIRED: a hold point release needs re-authentication (got %)',
      sig.auth_strength;
  END IF;

  IF NOT auth.may_release_hold(NEW.itp_checkpoint_id, NEW.released_by) THEN
    RAISE EXCEPTION
      'LOTLINE_RELEASE_NOT_NOMINATED: this user does not hold the nominated release role on the correct side of the contract';
  END IF;

  -- A concession release must actually have an approved concession behind it.
  IF NEW.release_kind = 'concession' THEN
    IF NOT EXISTS (SELECT 1 FROM concession co
                    WHERE co.id = NEW.concession_id
                      AND co.status IN ('em_approved','client_approved')) THEN
      RAISE EXCEPTION 'LOTLINE_CONCESSION_NOT_APPROVED';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hold_release_authority
  BEFORE INSERT ON hold_release
  FOR EACH ROW EXECUTE FUNCTION public.assert_release_authority();

-- ---------------------------------------------------------------------------
-- A retrospective release always raises a process NCR when the decision itself
-- came after the work (ADR-0019). An administrative lag does not.
-- ---------------------------------------------------------------------------
-- The NCR register arrives with domain G; until then the classification and its
-- consequence are recorded here so the rule is live from the first release
-- rather than retro-fitted.
CREATE TABLE retrospective_release_outcome (
  retrospective_release_id uuid PRIMARY KEY REFERENCES retrospective_release(id),
  lag_class                text NOT NULL,
  ncr_required             boolean NOT NULL,
  proposed_severity        text CHECK (proposed_severity IN ('minor','major','critical')),
  rationale                text NOT NULL,
  determined_at            timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.classify_retrospective_release() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_required boolean; v_severity text; v_rationale text;
BEGIN
  IF NEW.lag_class = 'administrative_lag' THEN
    v_required  := false;
    v_severity  := NULL;
    v_rationale := 'The release decision was made before work proceeded and is evidenced by a '
                || NEW.decision_evidence_kind
                || '. The hold point did its job; only the signature was late. Logged and counted, no NCR.';
  ELSE
    v_required := true;
    -- Severity by verification basis, not suppressed.
    v_severity := CASE NEW.verification_basis
                    WHEN 'contemporaneous_evidence' THEN 'minor'
                    WHEN 'physical_reinspection'    THEN 'minor'
                    ELSE 'major'
                  END;
    v_rationale := CASE NEW.verification_basis
      WHEN 'contemporaneous_evidence' THEN
        'Work proceeded past an unreleased hold point. Conformity at the time is evidenced contemporaneously, so this is a process non-conformance: closeable with the release record as its own evidence.'
      WHEN 'physical_reinspection' THEN
        'Work proceeded past an unreleased hold point and was verified by physical reinspection. Standard closeout.'
      WHEN 'destructive_verification' THEN
        'Work proceeded past an unreleased hold point and someone had to cut into finished work to verify it.'
      ELSE
        'Work proceeded past an unreleased hold point and nobody can say how they satisfied themselves it conformed. That is the whole problem, and recording it should be expensive: Engineering Manager disposition is mandatory and it cannot be closed as Use As Is without a client concession.'
    END;
  END IF;

  INSERT INTO retrospective_release_outcome
    (retrospective_release_id, lag_class, ncr_required, proposed_severity, rationale)
  VALUES (NEW.id, NEW.lag_class, v_required, v_severity, v_rationale);
  RETURN NEW;
END $$;

CREATE TRIGGER retrospective_release_classify
  AFTER INSERT ON retrospective_release
  FOR EACH ROW EXECUTE FUNCTION public.classify_retrospective_release();

-- ---------------------------------------------------------------------------
-- Correction: supersession, never mutation (C13)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correct_checkpoint(
  p_checkpoint_id uuid,
  p_kind          text,
  p_reason        text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE old_cp record; new_id uuid; corr_id uuid; sig record;
BEGIN
  SELECT * INTO old_cp FROM itp_checkpoint WHERE id = p_checkpoint_id;
  IF old_cp IS NULL THEN RAISE EXCEPTION 'LOTLINE_CHECKPOINT_MISSING'; END IF;
  IF old_cp.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_ALREADY_CORRECTED';
  END IF;
  IF NOT auth.has_permission('checkpoint.correct', old_cp.project_id) THEN
    RAISE EXCEPTION 'LOTLINE_CORRECTION_NOT_AUTHORISED';
  END IF;

  -- The replacement is created FIRST, then the original steps aside, so the
  -- partial unique index on (instance, sequence) is never violated.
  INSERT INTO itp_checkpoint
    (project_id, itp_instance_id, source_checkpoint_id, sequence_no, activity,
     checkpoint_type, responsible_party, release_role_id, acceptance_criteria,
     notice_hours, blocking_scope, state, assigned_to, subcontract_package_id,
     corrected_from_id)
  SELECT project_id, itp_instance_id, source_checkpoint_id, sequence_no, activity,
         checkpoint_type, responsible_party, release_role_id, acceptance_criteria,
         notice_hours, blocking_scope, 'pending', assigned_to, subcontract_package_id,
         id
    FROM itp_checkpoint WHERE id = p_checkpoint_id
  RETURNING id INTO new_id;

  UPDATE itp_checkpoint SET superseded_by_id = new_id, updated_at = now()
   WHERE id = p_checkpoint_id;

  INSERT INTO checkpoint_correction
    (project_id, itp_checkpoint_id, replacement_checkpoint_id, correction_kind,
     reason, corrected_by)
  VALUES (old_cp.project_id, p_checkpoint_id, new_id, p_kind, p_reason, auth.user_id())
  RETURNING id INTO corr_id;

  -- Every signature on the original is set aside -- not deleted, not altered.
  -- An auditor sees a signature that happened and was later withdrawn.
  FOR sig IN
    SELECT * FROM signature
     WHERE subject_type = 'itp_checkpoint' AND subject_id = p_checkpoint_id
  LOOP
    INSERT INTO signature_withdrawal
      (project_id, signature_id, checkpoint_correction_id, reason, withdrawn_by)
    VALUES (old_cp.project_id, sig.id, corr_id, p_reason, auth.user_id())
    ON CONFLICT (signature_id) DO NOTHING;
  END LOOP;

  RETURN new_id;
END $$;
GRANT EXECUTE ON FUNCTION public.correct_checkpoint(uuid, text, text)
  TO lotline_app, lotline_worker;

COMMENT ON FUNCTION public.correct_checkpoint IS
  'Corrects a checkpoint by supersession. If the corrected checkpoint is a hold, its replacement has no clearance record and RE-BLOCKS immediately -- a correction cannot be used to launder a hold point.';
