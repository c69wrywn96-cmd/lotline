-- 0029 — correct_checkpoint violated its own unique index.
--
-- 0027 created the replacement checkpoint first and superseded the original
-- afterwards, with a comment claiming that order kept the partial unique index
-- on (itp_instance_id, sequence_no) WHERE superseded_by_id IS NULL satisfied. It
-- does not: between the two statements BOTH rows are live at the same sequence,
-- and the insert fails. Found by T9.
--
-- The fix separates "has been superseded" from "by which row". A superseded_at
-- timestamp leaves the index immediately, so the original steps aside BEFORE the
-- replacement is created and the pointer is set afterwards.

ALTER TABLE itp_checkpoint ADD COLUMN superseded_at timestamptz;

UPDATE itp_checkpoint SET superseded_at = now() WHERE superseded_by_id IS NOT NULL;

DROP INDEX itp_checkpoint_live_sequence;
CREATE UNIQUE INDEX itp_checkpoint_live_sequence
  ON itp_checkpoint (itp_instance_id, sequence_no) WHERE superseded_at IS NULL;

-- Every place that asks "is this the live checkpoint" now asks the same question.
CREATE OR REPLACE FUNCTION public.itp_blocking_predecessor(p_checkpoint_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT c.id
    FROM itp_checkpoint c
    JOIN itp_checkpoint target ON target.id = p_checkpoint_id
   WHERE c.itp_instance_id  = target.itp_instance_id
     AND c.sequence_no      < target.sequence_no
     AND c.checkpoint_type   = 'hold'
     AND c.blocking_scope    = 'all_subsequent'
     AND c.superseded_at    IS NULL
     AND NOT public.itp_checkpoint_cleared(c.id)
   ORDER BY c.sequence_no
   LIMIT 1;
$$;

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
  IF old_cp.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'LOTLINE_ALREADY_CORRECTED';
  END IF;
  IF NOT auth.has_permission('checkpoint.correct', old_cp.project_id) THEN
    RAISE EXCEPTION 'LOTLINE_CORRECTION_NOT_AUTHORISED';
  END IF;

  -- Step aside FIRST, so the sequence is free for the replacement.
  UPDATE itp_checkpoint SET superseded_at = now(), updated_at = now()
   WHERE id = p_checkpoint_id;

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

  UPDATE itp_checkpoint SET superseded_by_id = new_id WHERE id = p_checkpoint_id;

  INSERT INTO checkpoint_correction
    (project_id, itp_checkpoint_id, replacement_checkpoint_id, correction_kind,
     reason, corrected_by)
  VALUES (old_cp.project_id, p_checkpoint_id, new_id, p_kind, p_reason, auth.user_id())
  RETURNING id INTO corr_id;

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

-- The superseded row is stepping aside, not progressing: it must not be caught
-- by the blocking trigger on its way out.
CREATE OR REPLACE FUNCTION public.assert_not_blocked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE blocker uuid; blocker_seq int;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.superseded_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.state IN ('not_applicable','failed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;

  blocker := public.itp_blocking_predecessor(NEW.id);
  IF blocker IS NOT NULL THEN
    SELECT sequence_no INTO blocker_seq FROM itp_checkpoint WHERE id = blocker;
    RAISE EXCEPTION
      'LOTLINE_HOLD_POINT_BLOCKED: checkpoint % cannot proceed while the hold point at sequence % is unreleased',
      NEW.sequence_no, blocker_seq;
  END IF;
  RETURN NEW;
END $$;
