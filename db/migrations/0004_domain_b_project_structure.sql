-- 0004 — Domain B: project, contract, the spatial framework and the vertical
-- datum.
--
-- The spatial framework is defined before the QA objects because a lot's
-- identity includes where it is — in plan AND in level (ADR-0004, ADR-0018).
--
-- Vertical position is never carried in geometry. geometry(PointZ, 7844) has a Z
-- ordinate with NO defined vertical datum — EPSG:7844 is a 2D geographic CRS —
-- so a height stored there looks authoritative and means nothing. Every reduced
-- level in this system is an explicit attribute paired with a named datum.

CREATE TABLE unit (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  code       text NOT NULL UNIQUE,        -- m3, m2, m, t, ea, lm
  name       text NOT NULL,
  dimension  text NOT NULL CHECK (dimension IN ('length','area','volume','mass','count','time'))
);

-- ---------------------------------------------------------------------------
-- Vertical datum (ADR-0018)
-- ---------------------------------------------------------------------------
-- Surveyors hand over AHD. An unnamed level is not evidence. Local and assumed
-- datums tied to a site benchmark are common enough on constrained sites to be
-- modelled rather than forced into a note on a survey report.
CREATE TABLE vertical_datum (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        uuid,   -- null = system reference datum; FK added below
  code              text        NOT NULL,
  name              text        NOT NULL,
  realisation_note  text,
  is_local          boolean     NOT NULL DEFAULT false,
  local_origin_note text,     -- the benchmark a local datum is tied to
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  CONSTRAINT local_datum_has_origin CHECK (is_local = false OR local_origin_note IS NOT NULL)
);
CREATE UNIQUE INDEX vertical_datum_system_code ON vertical_datum (code) WHERE project_id IS NULL;
CREATE UNIQUE INDEX vertical_datum_project_code ON vertical_datum (project_id, code)
  WHERE project_id IS NOT NULL;

INSERT INTO vertical_datum (code, name, realisation_note, is_local) VALUES
  ('AHD71',     'Australian Height Datum 1971',
   'National vertical datum for mainland Australia.', false),
  ('AHD_TAS83', 'Australian Height Datum (Tasmania) 1983',
   'Vertical datum for Tasmania.', false);

-- ---------------------------------------------------------------------------
-- Project
-- ---------------------------------------------------------------------------
CREATE TABLE project (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name                      text        NOT NULL,
  code                      text        NOT NULL UNIQUE,
  client_org_id             uuid        NOT NULL REFERENCES organisation(id),
  status                    text        NOT NULL DEFAULT 'delivery'
                            CHECK (status IN ('tender','delivery','defects_liability','closed')),
  -- The project's working projected CRS. Areas, lengths and quantities are
  -- computed in this SRID, not on geography, so they match the surveyor.
  mga_zone                  int         NOT NULL CHECK (mga_zone BETWEEN 49 AND 56),
  project_srid              int         NOT NULL CHECK (project_srid BETWEEN 7849 AND 7856),
  default_vertical_datum_id uuid        NOT NULL REFERENCES vertical_datum(id),
  boundary                  geometry(MultiPolygon, 7844),
  delivery_period           daterange,
  defects_liability_end     date,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid,
  -- MGA zone 56 is EPSG:7856, zone 49 is 7849. Getting this pair inconsistent
  -- is how lots end up in the wrong hemisphere of the grid.
  CONSTRAINT mga_zone_matches_srid CHECK (project_srid = 7800 + mga_zone)
);
CREATE INDEX project_boundary_gix ON project USING gist (boundary);

ALTER TABLE vertical_datum ADD CONSTRAINT vertical_datum_project_fk
  FOREIGN KEY (project_id) REFERENCES project(id);
ALTER TABLE device ADD CONSTRAINT device_project_fk
  FOREIGN KEY (project_id) REFERENCES project(id);
ALTER TABLE permission_grant ADD CONSTRAINT permission_grant_project_fk
  FOREIGN KEY (project_id) REFERENCES project(id);
ALTER TABLE delegation ADD CONSTRAINT delegation_project_fk
  FOREIGN KEY (project_id) REFERENCES project(id);

-- ---------------------------------------------------------------------------
-- Contract
-- ---------------------------------------------------------------------------
CREATE TABLE contract (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id                uuid        NOT NULL UNIQUE REFERENCES project(id),
  contract_number           text        NOT NULL,
  superintendent_user_id    uuid        REFERENCES user_account(id),
  verifier_org_id           uuid        REFERENCES organisation(id),
  spec_suite                text        NOT NULL
                            CHECK (spec_suite IN ('TfNSW','DTP_VIC','TMR_QLD','MRWA','custom')),
  -- ADR-0022. Default not_required: under most TfNSW and D&C arrangements the
  -- contractor certifies conformance and the Superintendent engages at hold
  -- points, witness points, surveillance and audit. On a 4,000-lot job a
  -- register that waits for client signatures jams permanently.
  client_lot_acceptance_mode text       NOT NULL DEFAULT 'not_required'
                            CHECK (client_lot_acceptance_mode
                                   IN ('not_required','nominated_work_types','all')),
  discloses_cost_impact      boolean    NOT NULL DEFAULT false,
  client_approves_materials  boolean    NOT NULL DEFAULT false,
  client_approves_design_changes boolean NOT NULL DEFAULT false,
  client_approves_survey     boolean    NOT NULL DEFAULT false,
  retention_years            int        NOT NULL DEFAULT 10,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid
);

-- ---------------------------------------------------------------------------
-- Participation: which organisations are on this project, in what capacity.
-- This is what makes a joint venture expressible (ADR-0001).
-- ---------------------------------------------------------------------------
CREATE TABLE project_participant (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id       uuid        NOT NULL REFERENCES project(id),
  organisation_id  uuid        NOT NULL REFERENCES organisation(id),
  participation    text        NOT NULL
                   CHECK (participation IN ('lead_contractor','jv_partner','client',
                                            'superintendent','verifier','subcontractor',
                                            'supplier','consultant')),
  jv_share_pct     numeric(5,2) CHECK (jv_share_pct IS NULL
                                       OR (jv_share_pct > 0 AND jv_share_pct <= 100)),
  branding_override jsonb,
  active_period    daterange   NOT NULL DEFAULT daterange(CURRENT_DATE, NULL, '[)'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid
);
CREATE UNIQUE INDEX project_participant_unique
  ON project_participant (project_id, organisation_id, participation);
CREATE INDEX project_participant_org ON project_participant (organisation_id);

CREATE TABLE discipline (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id uuid NOT NULL REFERENCES project(id),
  code       text NOT NULL,
  name       text NOT NULL,
  UNIQUE (project_id, code)
);

CREATE TABLE subcontract_package (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id            uuid NOT NULL REFERENCES project(id),
  subcontractor_org_id  uuid NOT NULL REFERENCES organisation(id),
  package_code          text NOT NULL,
  scope_description     text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  UNIQUE (project_id, package_code)
);

-- ---------------------------------------------------------------------------
-- Alignment and chainage (ADR-0005)
-- ---------------------------------------------------------------------------
-- The centreline is LineStringM with M carrying chainage directly, so PostGIS
-- linear referencing gives chainage<->coordinate conversion correctly by
-- construction. Chainage equations record the discontinuities real alignments
-- have; without them, chainage->coordinate is silently wrong downstream of
-- every re-design.
CREATE TABLE alignment (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        uuid        NOT NULL REFERENCES project(id),
  name              text        NOT NULL,
  centreline        geometry(LineStringM, 7844) NOT NULL,
  start_chainage_m  numeric(12,3) NOT NULL,
  end_chainage_m    numeric(12,3) NOT NULL,
  source_srid       int         NOT NULL,
  source_ref        text,
  revision          int         NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  superseded_by_id  uuid REFERENCES alignment(id),
  superseded_at     timestamptz,
  supersede_reason  text,
  CONSTRAINT chainage_increases CHECK (end_chainage_m > start_chainage_m)
);
CREATE INDEX alignment_gix ON alignment USING gist (centreline);
CREATE UNIQUE INDEX alignment_name_live ON alignment (project_id, name, revision);

CREATE TABLE alignment_equation (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  alignment_id     uuid NOT NULL REFERENCES alignment(id),
  back_chainage_m  numeric(12,3) NOT NULL,
  ahead_chainage_m numeric(12,3) NOT NULL,
  reason           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alignment_id, back_chainage_m)
);

-- ---------------------------------------------------------------------------
-- Zone and WBS: both nest, both carry an ltree path so RLS scope containment is
-- a GiST probe rather than a recursive subquery per row (ADR-0020).
-- ---------------------------------------------------------------------------
CREATE TABLE zone (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id     uuid        NOT NULL REFERENCES project(id),
  parent_zone_id uuid        REFERENCES zone(id),
  code           text        NOT NULL,
  name           text        NOT NULL,
  path           ltree       NOT NULL,
  boundary       geometry(MultiPolygon, 7844),
  alignment_id   uuid        REFERENCES alignment(id),
  chainage_range_m numrange,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  UNIQUE (project_id, code),
  -- ltree labels allow [A-Za-z0-9_] only, so codes must be label-safe.
  CONSTRAINT zone_code_label_safe CHECK (code ~ '^[A-Za-z0-9_]+$')
);
CREATE INDEX zone_path_gix ON zone USING gist (path);
CREATE INDEX zone_boundary_gix ON zone USING gist (boundary);
CREATE INDEX zone_chainage_gix ON zone USING gist (chainage_range_m);

ALTER TABLE device ADD CONSTRAINT device_zone_fk
  FOREIGN KEY (bound_zone_id) REFERENCES zone(id);

CREATE TABLE wbs_element (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id       uuid        NOT NULL REFERENCES project(id),
  parent_id        uuid        REFERENCES wbs_element(id),
  discipline_id    uuid        REFERENCES discipline(id),
  wbs_code         text        NOT NULL,
  description      text        NOT NULL,
  path             ltree       NOT NULL,
  budget_quantity  numeric(14,3),
  unit_id          uuid        REFERENCES unit(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  UNIQUE (project_id, wbs_code)
);
CREATE INDEX wbs_path_gix ON wbs_element USING gist (path);

-- Maintain the ltree paths from the parent links. Application code never sets
-- `path`; it is derived, and re-parenting rewrites the whole subtree (which is
-- what makes access_grant.scope_path safe to rely on).
CREATE OR REPLACE FUNCTION public.maintain_zone_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_path ltree;
BEGIN
  IF NEW.parent_zone_id IS NULL THEN
    NEW.path := NEW.code::ltree;
  ELSE
    SELECT path INTO parent_path FROM zone WHERE id = NEW.parent_zone_id;
    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'LOTLINE_ZONE_PARENT_MISSING';
    END IF;
    IF TG_OP = 'UPDATE' AND parent_path <@ OLD.path THEN
      RAISE EXCEPTION 'LOTLINE_ZONE_CYCLE: cannot re-parent a zone beneath itself';
    END IF;
    NEW.path := parent_path || NEW.code::ltree;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zone_path_maintain BEFORE INSERT OR UPDATE OF code, parent_zone_id ON zone
  FOR EACH ROW EXECUTE FUNCTION public.maintain_zone_path();

CREATE OR REPLACE FUNCTION public.cascade_zone_path() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path THEN
    UPDATE zone SET path = NEW.path || subpath(path, nlevel(OLD.path))
     WHERE path <@ OLD.path AND id <> NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER zone_path_cascade AFTER UPDATE OF path ON zone
  FOR EACH ROW EXECUTE FUNCTION public.cascade_zone_path();

CREATE OR REPLACE FUNCTION public.maintain_wbs_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_path ltree; label text;
BEGIN
  -- WBS codes are dotted (3.2.1); ltree labels cannot contain dots, so the leaf
  -- label is the final segment and the tree structure carries the rest.
  label := regexp_replace(split_part(NEW.wbs_code, '.', array_length(string_to_array(NEW.wbs_code,'.'),1)),
                          '[^A-Za-z0-9_]', '_', 'g');
  IF NEW.parent_id IS NULL THEN
    NEW.path := ('w' || label)::ltree;
  ELSE
    SELECT path INTO parent_path FROM wbs_element WHERE id = NEW.parent_id;
    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'LOTLINE_WBS_PARENT_MISSING';
    END IF;
    IF TG_OP = 'UPDATE' AND parent_path <@ OLD.path THEN
      RAISE EXCEPTION 'LOTLINE_WBS_CYCLE: cannot re-parent an element beneath itself';
    END IF;
    NEW.path := parent_path || ('w' || label)::ltree;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wbs_path_maintain BEFORE INSERT OR UPDATE OF wbs_code, parent_id ON wbs_element
  FOR EACH ROW EXECUTE FUNCTION public.maintain_wbs_path();

CREATE OR REPLACE FUNCTION public.cascade_wbs_path() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path THEN
    UPDATE wbs_element SET path = NEW.path || subpath(path, nlevel(OLD.path))
     WHERE path <@ OLD.path AND id <> NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER wbs_path_cascade AFTER UPDATE OF path ON wbs_element
  FOR EACH ROW EXECUTE FUNCTION public.cascade_wbs_path();

-- ---------------------------------------------------------------------------
-- Work type library and lot numbering
-- ---------------------------------------------------------------------------
CREATE TABLE work_type (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        uuid NOT NULL REFERENCES project(id),
  discipline_id     uuid NOT NULL REFERENCES discipline(id),
  code              text NOT NULL,
  name              text NOT NULL,
  default_unit_id   uuid REFERENCES unit(id),
  geometry_kind     text NOT NULL CHECK (geometry_kind IN ('polygon','line','point')),
  requires_chainage boolean NOT NULL DEFAULT true,
  -- Whether this work type participates in the pavement layer cake, and is
  -- therefore RL-bearing: subgrade RL 32.450, SBC RL 32.600, same footprint.
  is_layered        boolean NOT NULL DEFAULT false,
  requires_rl       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  UNIQUE (project_id, code),
  CONSTRAINT layered_requires_rl CHECK (is_layered = false OR requires_rl = true)
);

CREATE TABLE contract_acceptance_work_type (
  contract_id  uuid NOT NULL REFERENCES contract(id),
  work_type_id uuid NOT NULL REFERENCES work_type(id),
  rationale    text NOT NULL,
  PRIMARY KEY (contract_id, work_type_id)
);

CREATE TABLE lot_number_scheme (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id     uuid NOT NULL UNIQUE REFERENCES project(id),
  template       text NOT NULL DEFAULT '{zone}-{worktype}-{seq:4}',
  sequence_scope text NOT NULL DEFAULT 'zone_worktype'
                 CHECK (sequence_scope IN ('project','zone','zone_worktype'))
);

CREATE TABLE coordinate_system (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        uuid NOT NULL REFERENCES project(id),
  srid              int  NOT NULL,
  label             text NOT NULL,
  is_default_import boolean NOT NULL DEFAULT false,
  UNIQUE (project_id, srid)
);
CREATE UNIQUE INDEX coordinate_system_one_default
  ON coordinate_system (project_id) WHERE is_default_import;

-- ---------------------------------------------------------------------------
-- Chainage <-> coordinate, honouring chainage equations (ADR-0005)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chainage_to_point(
  p_alignment_id uuid,
  p_chainage_m   numeric
) RETURNS geometry
LANGUAGE plpgsql STABLE AS $$
DECLARE
  a          record;
  effective  numeric := p_chainage_m;
  eq         record;
BEGIN
  SELECT * INTO a FROM alignment WHERE id = p_alignment_id;
  IF a IS NULL THEN
    RAISE EXCEPTION 'LOTLINE_ALIGNMENT_MISSING';
  END IF;

  -- Apply chainage equations in order: each shifts the measure downstream of
  -- its back chainage. Ignoring these puts lots in the wrong place after every
  -- re-design that did not re-chainage.
  FOR eq IN
    SELECT * FROM alignment_equation
     WHERE alignment_id = p_alignment_id AND back_chainage_m <= p_chainage_m
     ORDER BY back_chainage_m
  LOOP
    effective := effective - (eq.ahead_chainage_m - eq.back_chainage_m);
  END LOOP;

  IF effective < a.start_chainage_m OR effective > a.end_chainage_m THEN
    RAISE EXCEPTION
      'LOTLINE_CHAINAGE_OUT_OF_RANGE: CH % resolves to % which is outside % .. %',
      p_chainage_m, effective, a.start_chainage_m, a.end_chainage_m;
  END IF;

  RETURN ST_GeometryN(ST_LocateAlong(a.centreline, effective), 1);
END $$;

COMMENT ON FUNCTION public.chainage_to_point IS
  'Chainage to coordinate on an alignment, applying chainage equations. Never assume a linear measure.';
