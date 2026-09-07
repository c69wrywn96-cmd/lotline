-- 0026 — Domain D: signatures, the ITP library, and the instance snapshot.
--
-- SEQUENCING NOTE. `lot` is created here WITHOUT geometry, reduced levels, or
-- any homogeneity model. TfNSW Q6 clause 5.4 defines Lot and the homogeneity
-- rules, and the instruction at design review 4 was to read that clause against
-- the schema before modelling it -- if they disagree, the schema is wrong, not
-- the spec. This environment's egress proxy blocks the Transport Standards
-- Portal, so that reading has not happened and none of it is guessed here. The
-- gate logic below does not depend on it.

-- ---------------------------------------------------------------------------
-- Signatures. One table for the whole system (ADR-0021).
-- ---------------------------------------------------------------------------
CREATE TABLE signature (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id             uuid        NOT NULL REFERENCES project(id),
  user_id                uuid        NOT NULL REFERENCES user_account(id),
  purpose                text        NOT NULL,
  subject_type           text        NOT NULL,
  subject_id             uuid        NOT NULL,
  -- The exact content signed. A signature that does not pin what it signed is
  -- an assertion, not evidence.
  subject_hash           text        NOT NULL,
  signature_method       text        NOT NULL
                         CHECK (signature_method IN ('click_to_sign','drawn','idp_reauth',
                                                     'passkey','device_pin','device_biometric')),
  auth_strength          text        NOT NULL
                         CHECK (auth_strength IN ('session','device_unlock','step_up')),
  authentication_event_id uuid       NOT NULL REFERENCES authentication_event(id),
  drawn_image_key        text,
  ip_address             inet,
  device_id              uuid        REFERENCES device(id),
  device_bound_session   boolean     NOT NULL DEFAULT false,
  user_agent             text,
  acting_role_id         uuid        REFERENCES role(id),
  delegation_id          uuid        REFERENCES delegation(id),
  signed_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signature_subject ON signature (subject_type, subject_id);
CREATE INDEX signature_auth_event ON signature (authentication_event_id);
REVOKE UPDATE, DELETE ON signature FROM lotline_app, lotline_worker, lotline_readonly;

CREATE TABLE signature_withdrawal (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id             uuid        NOT NULL REFERENCES project(id),
  signature_id           uuid        NOT NULL UNIQUE REFERENCES signature(id),
  checkpoint_correction_id uuid,
  reason                 text        NOT NULL,
  withdrawn_by           uuid        NOT NULL REFERENCES user_account(id),
  countersigned_by       uuid        REFERENCES user_account(id),
  countersigned_via      text        CHECK (countersigned_via IN ('project','organisation')),
  escalation_event_id    uuid        REFERENCES escalation_event(id),
  withdrawn_at           timestamptz NOT NULL DEFAULT now(),
  -- A signatory cannot withdraw their own signature: that is the whole reason
  -- the counter-signature machinery exists (ADR-0023, ADR-0028).
  CONSTRAINT countersigned_when_present CHECK (
    (countersigned_by IS NULL) = (countersigned_via IS NULL)
  )
);
REVOKE UPDATE, DELETE ON signature_withdrawal FROM lotline_app, lotline_worker, lotline_readonly;

-- ---------------------------------------------------------------------------
-- Lot — identity and lifecycle only. Geometry deferred (see note above).
-- ---------------------------------------------------------------------------
CREATE TABLE lot (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id            uuid NOT NULL REFERENCES project(id),
  zone_id               uuid NOT NULL REFERENCES zone(id),
  wbs_element_id        uuid NOT NULL REFERENCES wbs_element(id),
  work_type_id          uuid NOT NULL REFERENCES work_type(id),
  discipline_id         uuid REFERENCES discipline(id),
  subcontract_package_id uuid REFERENCES subcontract_package(id),
  lot_number            text NOT NULL,
  status                text NOT NULL DEFAULT 'Draft'
                        CHECK (status IN ('Draft','Open','In Progress',
                                          'Awaiting Hold Point Release','Held',
                                          'Awaiting Test Results','Ready for Review',
                                          'Submitted to Client','Conformed',
                                          'Non-Conforming','Superseded')),
  conformance_qualifier text NOT NULL DEFAULT 'full'
                        CHECK (conformance_qualifier IN ('full','with_concession')),
  -- Materialised for RLS scope containment, exactly as zone/wbs (ADR-0020).
  zone_path             ltree NOT NULL,
  wbs_path              ltree NOT NULL,
  quantity              numeric(14,3),
  unit_id               uuid REFERENCES unit(id),
  responsible_engineer_id uuid REFERENCES user_account(id),
  raised_on             date,
  first_hold_blocked_at timestamptz,
  client_accepted_at    timestamptz,
  client_acceptance_signature_id uuid REFERENCES signature(id),
  superseded_by_id      uuid REFERENCES lot(id),
  superseded_at         timestamptz,
  supersede_reason      text,
  locked_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  UNIQUE (project_id, lot_number)
);
CREATE INDEX lot_zone_path_gix ON lot USING gist (zone_path);
CREATE INDEX lot_wbs_path_gix ON lot USING gist (wbs_path);
CREATE INDEX lot_register ON lot (project_id, status, zone_id, work_type_id)
  WHERE superseded_by_id IS NULL;

COMMENT ON TABLE lot IS
  'Identity and lifecycle only. Geometry, reduced levels and the homogeneity model are deliberately absent pending a reading of TfNSW Q6 cl 5.4 (design review 4).';

-- Paths are derived, never set by application code.
CREATE OR REPLACE FUNCTION public.maintain_lot_paths() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT path INTO NEW.zone_path FROM zone WHERE id = NEW.zone_id;
  SELECT path INTO NEW.wbs_path  FROM wbs_element WHERE id = NEW.wbs_element_id;
  IF NEW.zone_path IS NULL OR NEW.wbs_path IS NULL THEN
    RAISE EXCEPTION 'LOTLINE_LOT_SCOPE_MISSING: zone or WBS element not found';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lot_paths BEFORE INSERT OR UPDATE OF zone_id, wbs_element_id ON lot
  FOR EACH ROW EXECUTE FUNCTION public.maintain_lot_paths();

-- Re-parenting a zone or WBS element must move its lots' materialised paths too.
CREATE OR REPLACE FUNCTION public.cascade_lot_paths() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  IF TG_TABLE_NAME = 'zone' THEN
    UPDATE lot SET zone_path = NEW.path WHERE zone_id = NEW.id;
  ELSE
    UPDATE lot SET wbs_path = NEW.path WHERE wbs_element_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER zone_lot_path_cascade AFTER UPDATE ON zone
  FOR EACH ROW WHEN (NEW.path IS DISTINCT FROM OLD.path)
  EXECUTE FUNCTION public.cascade_lot_paths();
CREATE TRIGGER wbs_lot_path_cascade AFTER UPDATE ON wbs_element
  FOR EACH ROW WHEN (NEW.path IS DISTINCT FROM OLD.path)
  EXECUTE FUNCTION public.cascade_lot_paths();

-- ---------------------------------------------------------------------------
-- Master ITP library
-- ---------------------------------------------------------------------------
CREATE TABLE itp_master (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  owner_org_id  uuid REFERENCES organisation(id),
  project_id    uuid REFERENCES project(id),
  code          text NOT NULL,
  title         text NOT NULL,
  work_type_id  uuid REFERENCES work_type(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  UNIQUE (project_id, code)
);

CREATE TABLE itp_master_version (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  itp_master_id  uuid NOT NULL REFERENCES itp_master(id),
  version_no     int  NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','in_review','published','withdrawn')),
  published_by   uuid REFERENCES user_account(id),
  published_at   timestamptz,
  -- Canonical hash of the published version. Copied onto every instance, so an
  -- audit can prove the instance is a faithful snapshot.
  content_hash   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  UNIQUE (itp_master_id, version_no),
  CONSTRAINT published_has_hash CHECK (
    status <> 'published' OR (content_hash IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE TABLE itp_master_checkpoint (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  itp_master_version_id uuid NOT NULL REFERENCES itp_master_version(id),
  sequence_no           int  NOT NULL,
  activity              text NOT NULL,
  checkpoint_type       text NOT NULL
                        CHECK (checkpoint_type IN ('hold','witness','surveillance','review','record')),
  responsible_party     text NOT NULL
                        CHECK (responsible_party IN ('contractor','subcontractor','client',
                                                     'verifier','laboratory','surveyor')),
  release_role_id       uuid REFERENCES role(id),
  acceptance_criteria   text NOT NULL,
  notice_hours          int,
  frequency_basis       text CHECK (frequency_basis IN ('per_lot','per_area','per_volume',
                                                        'per_delivery','per_day','per_length')),
  frequency_value       numeric,
  blocking_scope        text NOT NULL DEFAULT 'none'
                        CHECK (blocking_scope IN ('all_subsequent','none')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (itp_master_version_id, sequence_no),
  -- ADR-0010, first of two mechanisms. A witness, surveillance, review or record
  -- checkpoint CANNOT be given a blocking scope, by any author, at any level. A
  -- Quality Manager who believes a witness point should stop work must model it
  -- as a hold point -- which is correct, and is visible to the client as such.
  CONSTRAINT only_holds_block CHECK (blocking_scope = 'none' OR checkpoint_type = 'hold'),
  CONSTRAINT hold_has_releaser CHECK (checkpoint_type <> 'hold' OR release_role_id IS NOT NULL),
  CONSTRAINT witness_has_notice CHECK (checkpoint_type <> 'witness' OR notice_hours IS NOT NULL)
);

CREATE TABLE itp_master_evidence_req (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  itp_master_checkpoint_id uuid NOT NULL REFERENCES itp_master_checkpoint(id),
  evidence_type            text NOT NULL
                           CHECK (evidence_type IN ('test_certificate','survey','photo','docket',
                                                    'checklist','calibration','mill_cert','concession')),
  min_count                int  NOT NULL DEFAULT 1 CHECK (min_count >= 1),
  mandatory                boolean NOT NULL DEFAULT true,
  description              text
);

-- ---------------------------------------------------------------------------
-- Instance: a PHYSICAL SNAPSHOT, not a pointer to a version (ADR-0008).
-- ---------------------------------------------------------------------------
CREATE TABLE itp_instance (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id            uuid NOT NULL REFERENCES project(id),
  lot_id                uuid NOT NULL UNIQUE REFERENCES lot(id),
  itp_master_version_id uuid NOT NULL REFERENCES itp_master_version(id),
  content_hash          text NOT NULL,
  snapshotted_at        timestamptz NOT NULL DEFAULT now(),
  snapshotted_by        uuid REFERENCES user_account(id),
  locked_at             timestamptz
);

CREATE TABLE itp_checkpoint (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id            uuid NOT NULL REFERENCES project(id),
  itp_instance_id       uuid NOT NULL REFERENCES itp_instance(id),
  -- Lineage back to the master row it was copied from. There is deliberately no
  -- path by which editing the master reaches this row.
  source_checkpoint_id  uuid REFERENCES itp_master_checkpoint(id),
  sequence_no           int  NOT NULL,
  activity              text NOT NULL,
  checkpoint_type       text NOT NULL
                        CHECK (checkpoint_type IN ('hold','witness','surveillance','review','record')),
  responsible_party     text NOT NULL,
  release_role_id       uuid REFERENCES role(id),
  acceptance_criteria   text NOT NULL,
  notice_hours          int,
  blocking_scope        text NOT NULL DEFAULT 'none'
                        CHECK (blocking_scope IN ('all_subsequent','none')),
  state                 text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','notified','in_progress','evidence_complete',
                                         'awaiting_release','released','signed','waived',
                                         'not_applicable','failed','superseded')),
  assigned_to           uuid REFERENCES user_account(id),
  subcontract_package_id uuid REFERENCES subcontract_package(id),
  reinspection_count    int  NOT NULL DEFAULT 0,
  completed_at          timestamptz,
  corrected_from_id     uuid REFERENCES itp_checkpoint(id),
  superseded_by_id      uuid REFERENCES itp_checkpoint(id),
  locked_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  -- The same constraint as the master. Enforced at BOTH levels so a blocking
  -- witness point is unrepresentable even if an instance were written directly.
  CONSTRAINT only_holds_block CHECK (blocking_scope = 'none' OR checkpoint_type = 'hold'),
  -- 'waived' is witness-only: a hold point never auto-waives (ADR-0010).
  CONSTRAINT waived_is_witness_only CHECK (state <> 'waived' OR checkpoint_type = 'witness')
);
-- Exactly one live checkpoint per sequence; a corrected one steps aside.
CREATE UNIQUE INDEX itp_checkpoint_live_sequence
  ON itp_checkpoint (itp_instance_id, sequence_no) WHERE superseded_by_id IS NULL;
CREATE INDEX itp_checkpoint_blocking
  ON itp_checkpoint (itp_instance_id, sequence_no, checkpoint_type, state)
  WHERE superseded_by_id IS NULL;

CREATE TABLE checkpoint_evidence_req (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  itp_checkpoint_id  uuid NOT NULL REFERENCES itp_checkpoint(id),
  evidence_type      text NOT NULL,
  min_count          int  NOT NULL DEFAULT 1 CHECK (min_count >= 1),
  mandatory          boolean NOT NULL DEFAULT true,
  description        text
);

CREATE TABLE checkpoint_evidence (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id         uuid NOT NULL REFERENCES project(id),
  itp_checkpoint_id  uuid NOT NULL REFERENCES itp_checkpoint(id),
  requirement_id     uuid REFERENCES checkpoint_evidence_req(id),
  subject_type       text NOT NULL,
  subject_id         uuid NOT NULL,
  attached_by        uuid REFERENCES user_account(id),
  attached_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkpoint_evidence_cp ON checkpoint_evidence (itp_checkpoint_id, requirement_id);

CREATE TABLE checkpoint_state_event (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        uuid NOT NULL REFERENCES project(id),
  itp_checkpoint_id uuid NOT NULL REFERENCES itp_checkpoint(id),
  from_state        text,
  to_state          text NOT NULL,
  actor_id          uuid REFERENCES user_account(id),
  reason            text,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON checkpoint_state_event FROM lotline_app, lotline_worker, lotline_readonly;

-- ---------------------------------------------------------------------------
-- Witness notice, and the clock that gets argued about in claims
-- ---------------------------------------------------------------------------
CREATE TABLE witness_notification (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id            uuid NOT NULL REFERENCES project(id),
  itp_checkpoint_id     uuid NOT NULL REFERENCES itp_checkpoint(id),
  notified_org_id       uuid REFERENCES organisation(id),
  notified_at           timestamptz NOT NULL DEFAULT now(),
  required_notice_hours int  NOT NULL,
  scheduled_inspection_at timestamptz NOT NULL,
  notice_satisfied_at   timestamptz,
  outcome               text NOT NULL DEFAULT 'pending'
                        CHECK (outcome IN ('pending','attended','waived_non_attendance',
                                           'declined','rescheduled')),
  outcome_at            timestamptz,
  outcome_recorded_by   uuid REFERENCES user_account(id),
  created_by            uuid,
  CONSTRAINT notice_precedes_inspection CHECK (
    scheduled_inspection_at >= notified_at + make_interval(hours => required_notice_hours)
  )
);
CREATE INDEX witness_notification_cp ON witness_notification (itp_checkpoint_id);

CREATE TABLE notification_delivery (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  witness_notification_id uuid NOT NULL REFERENCES witness_notification(id),
  recipient_user_id       uuid REFERENCES user_account(id),
  channel                 text NOT NULL CHECK (channel IN ('email','sms','in_app','webhook')),
  status                  text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','sent','delivered','bounced','read')),
  sent_at                 timestamptz,
  delivered_at            timestamptz,
  provider_message_id     text
);
CREATE INDEX notification_delivery_notice ON notification_delivery (witness_notification_id, status);

-- ---------------------------------------------------------------------------
-- Clearance records: the three release kinds (ADR-0010, ADR-0019)
-- ---------------------------------------------------------------------------
CREATE TABLE concession (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id            uuid NOT NULL REFERENCES project(id),
  subject_type          text NOT NULL CHECK (subject_type IN ('itp_checkpoint','lot','ncr')),
  subject_id            uuid NOT NULL,
  reason                text NOT NULL,
  requested_by          uuid NOT NULL REFERENCES user_account(id),
  engineering_manager_signature_id uuid REFERENCES signature(id),
  client_signature_id   uuid REFERENCES signature(id),
  document_subject_id   uuid,
  status                text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested','em_approved','client_approved','rejected')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT em_approval_signed CHECK (
    status NOT IN ('em_approved','client_approved') OR engineering_manager_signature_id IS NOT NULL
  ),
  CONSTRAINT client_approval_signed CHECK (
    status <> 'client_approved' OR client_signature_id IS NOT NULL
  )
);

CREATE TABLE retrospective_release (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id            uuid NOT NULL REFERENCES project(id),
  itp_checkpoint_id     uuid NOT NULL REFERENCES itp_checkpoint(id),
  work_proceeded_at     timestamptz NOT NULL,
  -- The field the whole ADR-0019 amendment turns on: WHEN the decision was made,
  -- as distinct from when it was signed.
  release_decision_at   timestamptz NOT NULL,
  released_at           timestamptz NOT NULL DEFAULT now(),
  retrospective_lag     interval GENERATED ALWAYS AS (released_at - work_proceeded_at) STORED,
  discovery_method      text NOT NULL
                        CHECK (discovery_method IN ('self_identified','internal_audit',
                                                    'client_surveillance','verifier_audit',
                                                    'system_reconciliation')),
  verification_basis    text NOT NULL
                        CHECK (verification_basis IN ('contemporaneous_evidence','physical_reinspection',
                                                      'destructive_verification','none')),
  -- Evidence that the release DECISION existed at the time. Without one of
  -- these, an administrative-lag claim is self-asserted, and lag_class below
  -- degrades it automatically.
  decision_evidence_kind text NOT NULL DEFAULT 'none'
                        CHECK (decision_evidence_kind IN ('none','witness','diary_entry',
                                                          'radio_log','photo','site_instruction')),
  decision_witness_user_id uuid REFERENCES user_account(id),
  decision_witness_name    text,
  decision_evidence_id     uuid,
  -- GENERATED, so the branch cannot be asserted by the person it exonerates.
  -- Claiming an administrative lag with nothing behind it does not fail: it
  -- degrades to unreleased_progression and raises the NCR (ADR-0019).
  lag_class             text GENERATED ALWAYS AS (
                          CASE WHEN release_decision_at <= work_proceeded_at
                                    AND decision_evidence_kind <> 'none'
                                    AND (decision_witness_user_id IS NOT NULL
                                      OR decision_witness_name    IS NOT NULL
                                      OR decision_evidence_id     IS NOT NULL)
                               THEN 'administrative_lag'
                               ELSE 'unreleased_progression'
                          END) STORED,
  justification         text NOT NULL,
  raised_ncr_id         uuid,
  recorded_by           uuid NOT NULL REFERENCES user_account(id),
  CONSTRAINT decision_not_after_signature CHECK (release_decision_at <= released_at),
  CONSTRAINT verification_needs_evidence CHECK (
    verification_basis = 'none' OR justification IS NOT NULL
  )
);
CREATE INDEX retrospective_release_cp ON retrospective_release (itp_checkpoint_id);
CREATE INDEX retrospective_release_trend ON retrospective_release (project_id, lag_class, released_at);

CREATE TABLE retrospective_verification_evidence (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  retrospective_release_id uuid NOT NULL REFERENCES retrospective_release(id),
  subject_type             text NOT NULL,
  subject_id               uuid NOT NULL
);

-- THE clearance record the blocking trigger looks for.
CREATE TABLE hold_release (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id               uuid NOT NULL REFERENCES project(id),
  itp_checkpoint_id        uuid NOT NULL REFERENCES itp_checkpoint(id),
  release_kind             text NOT NULL
                           CHECK (release_kind IN ('standard','concession','retrospective')),
  released_by              uuid NOT NULL REFERENCES user_account(id),
  -- NOT NULL for every kind. There is no unsigned clearance.
  signature_id             uuid NOT NULL REFERENCES signature(id),
  released_at              timestamptz NOT NULL DEFAULT now(),
  conditions               text,
  concession_id            uuid REFERENCES concession(id),
  retrospective_release_id uuid REFERENCES retrospective_release(id),
  superseded_by_id         uuid REFERENCES hold_release(id),
  CONSTRAINT release_kind_has_its_record CHECK (
       (release_kind = 'standard'      AND concession_id IS NULL AND retrospective_release_id IS NULL)
    OR (release_kind = 'concession'    AND concession_id IS NOT NULL AND retrospective_release_id IS NULL)
    OR (release_kind = 'retrospective' AND retrospective_release_id IS NOT NULL AND concession_id IS NULL)
  )
);
CREATE INDEX hold_release_clearance ON hold_release (itp_checkpoint_id)
  WHERE superseded_by_id IS NULL;
REVOKE UPDATE, DELETE ON hold_release FROM lotline_app, lotline_worker, lotline_readonly;
REVOKE UPDATE, DELETE ON retrospective_release FROM lotline_app, lotline_worker, lotline_readonly;

CREATE TABLE checkpoint_correction (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id               uuid NOT NULL REFERENCES project(id),
  itp_checkpoint_id        uuid NOT NULL REFERENCES itp_checkpoint(id),
  replacement_checkpoint_id uuid REFERENCES itp_checkpoint(id),
  correction_kind          text NOT NULL
                           CHECK (correction_kind IN ('wrong_checkpoint_signed','wrong_signatory',
                                                      'incorrect_evidence_attached','data_entry_error')),
  reason                   text NOT NULL,
  corrected_by             uuid NOT NULL REFERENCES user_account(id),
  countersigned_by         uuid REFERENCES user_account(id),
  countersigned_via        text CHECK (countersigned_via IN ('project','organisation')),
  corrected_at             timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE signature_withdrawal
  ADD CONSTRAINT signature_withdrawal_correction_fk
  FOREIGN KEY (checkpoint_correction_id) REFERENCES checkpoint_correction(id);

SELECT public.revoke_delete_everywhere();
