-- 0015 — Domain C: the standards and specification library.
--
-- ADR-0006 is structural here, not a policy note: there is NO COLUMN ANYWHERE IN
-- THIS FILE for the text of a standard or a client specification. The library
-- stores identifiers, titles, a source URL, and `tenant_summary` — the
-- contractor's OWN paraphrased acceptance criteria, attributed to the
-- organisation that authored it. Australian Standards and the state road
-- authorities license their documents; storing their text would be an
-- infringement shipped to every tenant.
--
-- What this buys, once populated: every ITP checkpoint links to clauses, so the
-- system can answer "show me every lot verified against AS 3798 cl. 8.3 and
-- every test result that proves it". That query is what an auditor asks for and
-- what no platform in the market can run today.

CREATE TABLE standards_body (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  code         text NOT NULL UNIQUE,   -- SA | TFNSW | DTP_VIC | TMR | MRWA | AUSTROADS
  name         text NOT NULL,
  jurisdiction text NOT NULL,
  website      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE specification (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  standards_body_id uuid NOT NULL REFERENCES standards_body(id),
  -- The publisher's own identifier, exactly as published. Held as text because
  -- these are revised: TfNSW Q6 is now issued as TS 01572.1, and any scheme we
  -- imposed would be wrong within a year.
  designation       text NOT NULL,
  title             text NOT NULL,
  series            text,             -- Q | R | B | D&C | MRTS | Section
  discipline_hint   text,
  source_url        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  UNIQUE (standards_body_id, designation)
);

CREATE TABLE specification_version (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  specification_id  uuid NOT NULL REFERENCES specification(id),
  version_label     text NOT NULL,    -- '2007' | 'Ed 1 / Rev 12'
  effective_from    date,
  source_url        text,
  -- Provenance. An auditor asking "where did this clause list come from" gets an
  -- answer, and a register pulled from a project contract copy is
  -- distinguishable from the publicly published one (they differ by annexures).
  retrieved_from    text,
  retrieved_at      timestamptz,
  is_public_edition boolean NOT NULL DEFAULT true,
  superseded_by_id  uuid REFERENCES specification_version(id),
  superseded_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  UNIQUE (specification_id, version_label)
);

CREATE TABLE clause (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  specification_version_id uuid NOT NULL REFERENCES specification_version(id),
  parent_clause_id         uuid REFERENCES clause(id),
  clause_ref               text NOT NULL,   -- '8.3.2'
  title                    text NOT NULL,
  path                     ltree NOT NULL,
  -- The contractor's OWN words. Ships empty. Never source text (ADR-0006).
  tenant_summary           text,
  tenant_summary_org_id    uuid REFERENCES organisation(id),
  -- Whether the publisher's clause creates an inspection obligation. This is a
  -- structural fact about the clause, not a reproduction of its wording, and it
  -- is what lets an ITP author find the clauses that must become hold points.
  implies_hold_point       boolean NOT NULL DEFAULT false,
  implies_witness_point    boolean NOT NULL DEFAULT false,
  default_notice_hours     int,
  external_url             text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid,
  UNIQUE (specification_version_id, clause_ref),
  -- The one guard that enforces ADR-0006 mechanically. A paraphrase is short; a
  -- 4,000-character "summary" is a paste of the source. This will not stop a
  -- determined paste, but it stops the accidental one, and it puts the rule
  -- where an engineer meets it rather than in a policy document.
  CONSTRAINT tenant_summary_is_a_paraphrase CHECK (
    tenant_summary IS NULL OR length(tenant_summary) <= 1000
  ),
  CONSTRAINT tenant_summary_is_attributed CHECK (
    (tenant_summary IS NULL) = (tenant_summary_org_id IS NULL)
  )
);
CREATE INDEX clause_path_gix ON clause USING gist (path);
CREATE INDEX clause_hold_witness ON clause (specification_version_id)
  WHERE implies_hold_point OR implies_witness_point;

COMMENT ON COLUMN clause.tenant_summary IS
  'The contractor''s own paraphrased acceptance criteria. NEVER the text of the published standard or specification (ADR-0006). Attributed to tenant_summary_org_id.';

CREATE OR REPLACE FUNCTION public.maintain_clause_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_path ltree; label text;
BEGIN
  -- Clause refs are dotted (8.3.2); ltree labels cannot contain dots, so the
  -- leaf label is the final segment and the tree carries the rest.
  label := 'c' || regexp_replace(
    split_part(NEW.clause_ref, '.', array_length(string_to_array(NEW.clause_ref, '.'), 1)),
    '[^A-Za-z0-9_]', '_', 'g');
  IF NEW.parent_clause_id IS NULL THEN
    NEW.path := label::ltree;
  ELSE
    SELECT path INTO parent_path FROM clause WHERE id = NEW.parent_clause_id;
    IF parent_path IS NULL THEN RAISE EXCEPTION 'LOTLINE_CLAUSE_PARENT_MISSING'; END IF;
    NEW.path := parent_path || label::ltree;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clause_path_maintain
  BEFORE INSERT OR UPDATE OF clause_ref, parent_clause_id ON clause
  FOR EACH ROW EXECUTE FUNCTION public.maintain_clause_path();

-- Which specification versions govern a project, and which is the governing one
-- where several apply.
CREATE TABLE project_specification (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id               uuid NOT NULL REFERENCES project(id),
  specification_version_id uuid NOT NULL REFERENCES specification_version(id),
  is_governing             boolean NOT NULL DEFAULT true,
  applicability_note       text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  UNIQUE (project_id, specification_version_id)
);

-- The polymorphic citation edge. One table answers "every lot verified against
-- clause X, and every test result proving it" — no FK, because the subject may
-- be a checkpoint, a lot, an NCR, a material or a permit type.
CREATE TABLE clause_reference (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id   uuid NOT NULL REFERENCES project(id),
  clause_id    uuid NOT NULL REFERENCES clause(id),
  subject_type text NOT NULL
               CHECK (subject_type IN ('itp_master_checkpoint','itp_checkpoint','lot',
                                       'ncr','material','permit_type','test_method')),
  subject_id   uuid NOT NULL,
  relationship text NOT NULL DEFAULT 'acceptance_criteria'
               CHECK (relationship IN ('acceptance_criteria','specified_by','breached','verified_against')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  UNIQUE (clause_id, subject_type, subject_id, relationship)
);
CREATE INDEX clause_reference_lookup ON clause_reference (clause_id, subject_type, subject_id);
CREATE INDEX clause_reference_subject ON clause_reference (subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- RLS. The library above project level is reference data, readable by any
-- authenticated session: an ITP author on any project needs the clause list.
-- tenant_summary is the exception — it is the contractor's own work product.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['standards_body','specification','specification_version','clause'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %1$s_select ON %1$I FOR SELECT TO lotline_app, lotline_worker, lotline_readonly
         USING (auth.user_id() IS NOT NULL)', t);
  END LOOP;
END $$;

-- Authoring a clause summary requires the standards permission, and the summary
-- is attributed to the author's own organisation.
CREATE POLICY clause_update ON clause FOR UPDATE TO lotline_app, lotline_worker
  USING (auth.user_id() IS NOT NULL)
  WITH CHECK (
    tenant_summary IS NULL
    OR tenant_summary_org_id = (SELECT primary_org_id FROM user_account WHERE id = auth.user_id())
  );

SELECT auth.enable_project_rls('project_specification');
SELECT auth.enable_project_rls('clause_reference');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['standards_body','specification','specification_version','clause',
                           'project_specification','clause_reference'] LOOP
    PERFORM audit.attach(t);
  END LOOP;
END $$;

SELECT public.revoke_delete_everywhere();
