# Architecture Decision Records

Per §0 of the build brief: every judgement call made in the absence of an explicit
requirement is recorded here as a numbered ADR. Status is `Proposed` until the
design review in §14 concludes.

---

### ADR-0001 — Tenancy is expressed by project participation, not a `tenant_id` column
**Status:** Proposed

**Context.** The brief requires joint ventures (two contractor tenants, one
project, separate branding, separate user pools) and requires client,
independent verifier, subcontractor and supplier users — all of whom belong to
*different* organisations — to hold scoped access to the same project. A single
`tenant_id` column on every table cannot express any of this without either
duplicating projects or dissolving the tenancy boundary.

**Decision.** The tenancy edge is `project_participant` (organisation × project ×
participation type). The access edge is `project_membership` (user × project ×
role × scope). RLS keys on a trigger-maintained flattening of the latter
(`access_grant`), never on an organisation column.

**Consequences.** JV is a first-class case rather than a workaround. Branding
resolves per participant. A user who moves between organisations keeps one
identity. Cost: every RLS predicate is an `EXISTS` against `access_grant` rather
than a column comparison — mitigated by making `access_grant`'s primary key
exactly the predicate's lookup.

---

### ADR-0002 — RBAC is permission-per-action, with roles as tenant-editable bundles
**Status:** Proposed

**Context.** The brief explicitly rejects "three hardcoded tiers". Real
authority varies by contract: on one project the client approves materials, on
the next they do not.

**Decision.** A `permission` catalogue of `resource.action` codes. Roles are rows
that bundle permissions with a `constraint_json` for numeric and contextual
bounds (cost ceilings, discipline restriction, contract flags). No application
code branches on a role name. Individual exceptions are time-boxed
`permission_grant` rows; cover arrangements are `delegation` rows.

**Consequences.** "Approve NCR closeout > $50k" is a constraint on an ordinary
permission, not a bespoke role. Tenants can model authority we have not
anticipated. Cost: permission resolution is more work than a tier check, so it is
cached per request and the authoritative checks live in the database.

---

### ADR-0003 — There is no delete; correction is supersession
**Status:** Proposed

**Context.** §13: "Do not implement delete. Ever." §11 requires that nothing
disappears and that corrections are linked.

**Decision.** No `deleted_at` column exists anywhere. `DELETE` is revoked from
every application database role, and `db.delete()` is banned by lint. Removal is
`superseded_by_id` + `superseded_at` + a mandatory reason. Signed rows carry
`locked_at` and a `BEFORE UPDATE` trigger that rejects any change other than
supersession fields.

**Consequences.** Every list view must filter `superseded_by_id IS NULL`; this is
done in the base repository layer, not per query, with partial indexes to match.
Storage grows monotonically — acceptable given the 10-year retention requirement,
and partitioning handles the audit log.

---

### ADR-0004 — Canonical geometry is EPSG:7844 (GDA2020 geographic); source geometry is retained; measurement happens in the project's MGA zone
**Status:** Proposed

**Context.** Australian survey data arrives as MGA2020 (EPSG:7849–7856, one zone
per project, occasionally two). GDA94 and GDA2020 differ by roughly 1.8 m — in
this industry that is a defect, not a rounding error. Web mapping needs 3857/4326.
Areas and volumes must reconcile with the surveyor's own numbers.

**Decision.** Three representations, explicitly:
1. `geom_source` + `source_srid` — exactly as imported, never transformed. The
   evidentiary record.
2. `geom` in EPSG:7844 — canonical, zone-independent, what all spatial
   relationships and RLS-adjacent queries use.
3. A generated `geom_3857` column — for `ST_AsMVT` vector tiles only.

All areas, lengths and offsets are computed as
`ST_Area(ST_Transform(geom, project.project_srid))` — planar metres in the
project's MGA zone — never on `geography`. Import **requires** an explicit SRID;
there is no default and no guess. GDA94 input is accepted but flagged and
transformed with an explicit, logged transformation.

**Consequences.** Storage triples for geometry columns. In exchange, a datum
dispute is resolvable from the record, quantities match the surveyor, and no lot
is silently 1.8 m out.

---

### ADR-0005 — Chainage is carried on the alignment's M ordinate, with explicit chainage equations
**Status:** Proposed

**Context.** Chainage↔coordinate conversion is central to the "everything at
CH 1450" query. Real alignments have chainage discontinuities where a re-design
was issued without re-chainaging; a naive "distance along the line" model is
silently wrong downstream of every one of them.

**Decision.** `alignment.centreline` is `LineStringZM` with M carrying chainage
directly, so PostGIS linear referencing is correct by construction.
`alignment_equation` rows record each back/ahead discontinuity and are applied by
the conversion functions. A project may have many alignments (mainline, side
roads, rail); a lot references the one it is chainaged against.

**Consequences.** LandXML import must populate M. Alignments are versioned; a lot
records which alignment revision it was chainaged against, so a re-issued design
does not move historical lots.

---

### ADR-0006 — The standards library stores identifiers and tenant-authored summaries only
**Status:** Proposed

**Context.** §13 forbids reproducing the text of Australian Standards or client
specifications. This is a copyright constraint with real legal weight — SA and
the state road authorities license their documents.

**Decision.** The schema has **no column for source text**. It stores
`standards_body`, `specification`, `specification_version`, `clause` (identifier,
title, external URL) and `clause.tenant_summary` — the contractor's own
paraphrased acceptance criteria, attributed to the authoring organisation. The
product ships the *structure* and the reference identifiers; tenants populate
content they are licensed to hold. The UI states this at the point of entry, and
the code comments on these tables record the constraint.

**Consequences.** A tenant must do data entry before the library is useful to
them. Mitigated by CSV import and by shipping the clause *skeletons* (numbers and
titles, which are factual references) for the major suites.

---

### ADR-0007 — Lot acceptance statistics are a configurable scheme; k-factor tables are tenant-populated
**Status:** Proposed

**Context.** §12.5 requires the system to compute a characteristic value and
decide lot acceptance. The statistical *methods* (mean minus k×standard
deviation, mean minus k×range, all-individual, mean-and-minimum) are public
engineering practice. The *k-factor tables keyed by sample count* are
specification content and fall under ADR-0006.

**Decision.** `acceptance_scheme` models the method, target, comparator, minimum
individual value and minimum sample count. `acceptance_k_factor` holds
(sample_count → k) rows and ships **empty**; tenants enter the values from their
licensed specification. Evaluation results are stored as
`lot_acceptance_evaluation` rows — one per run — recording the k value actually
used, so an audit can reproduce the arithmetic.

**Consequences.** The statistics are correct and reproducible without shipping
licensed content. A project cannot evaluate acceptance until its schemes are
populated; the lot register surfaces "no acceptance scheme configured" as a
blocking configuration warning rather than silently passing.

---

### ADR-0008 — An ITP instance is a physical snapshot, not a pointer to a version
**Status:** Proposed

**Context.** The brief requires that later ITP revisions never retroactively
alter closed lots.

**Decision.** At lot raise, the published master version's checkpoints are
**copied** into `itp_instance` / `itp_checkpoint`, with `source_checkpoint_id`
retained for lineage and `content_hash` copied for verification. There is no FK
path by which editing a master reaches an instance.

**Consequences.** Row count grows with lots × checkpoints (a 4,000-lot project
with 15-checkpoint ITPs is 60,000 rows — trivial). A bug in a published master
must be fixed by publishing a new version and, where required, superseding
affected lots — which is the correct engineering behaviour, not a limitation.

---

### ADR-0009 — Conformance packs are assembled from artefacts pre-rendered at ingest
**Status:** Proposed

**Context.** §5.2 requires a bookmarked, hyperlinked, indexed PDF in under 10
seconds, and batch volumes of hundreds of lots.

**Decision.** Every uploaded document is rendered to PDF **asynchronously at
ingest** and stored as `document_revision.pdf_render_key` with its page count.
Pack generation is then: render the four generated sections (cover, conformance
statement, ITP, NCR summary) with Chromium; merge the pre-rendered artefacts with
`pdf-lib`; compute the bookmark tree and page numbering from the known page
counts; stamp the status watermark. No artefact is rendered during pack
generation.

**Consequences.** The p95 target becomes achievable because the variable cost
(rendering a 40-page test certificate) moves off the critical path. Cost: extra
storage per document, and a pack cannot generate until every artefact's render is
complete — surfaced as a progress state rather than a failure. Batch mode reuses
the same rendered assets, so a 300-lot volume is near-linear merge cost.

---

### ADR-0010 — Hold-point blocking is a database trigger; the sole bypass is a signed concession
**Status:** Proposed

**Context.** §13: "Do not let a hold point be bypassed by any role without a
recorded concession." §12.4 requires proof of blocking.

**Decision.** `itp_blocking_predecessor()` plus a `BEFORE UPDATE` trigger on
`itp_checkpoint` and a `BEFORE INSERT` trigger on `checkpoint_evidence`. No
permission, role, flag or environment variable suppresses it. The only path past
a hold is guard C10: a `concession` with an Engineering Manager signature and, for
client-nominated holds, a client signature and an attached document — which
writes a normal `hold_release` carrying `concession_id`, and which appears on the
conformance pack.

**Consequences.** Blocking is provable in `psql`, independent of the application.
Emergency situations require the concession workflow rather than an override
switch; this is intended.

---

### ADR-0011 — Conformance under concession is a qualifier on `Conformed`, not a separate status
**Status:** Proposed

**Context.** The brief lists `Non-Conforming` in the lot status enumeration but
does not say how a lot accepted under a *Use As Is* concession is represented.
Modelling it as `Conformed` alone hides the concession; modelling it as
`Non-Conforming` misrepresents an accepted lot.

**Decision.** `lot.conformance_qualifier ∈ {full, with_concession}`. A lot that
reached `Conformed` via any concession carries `with_concession`, which is
surfaced in the register, on the map colouring, and on the conformance pack
watermark. `Non-Conforming` is reserved for a determination that the work does
not conform and has not been accepted.

**Consequences.** The register can answer "how many lots did we conform on
concession", which is a question clients and auditors ask and which no
competitor's status enum can answer.

---

### ADR-0012 — `Held` and `Awaiting Hold Point Release` are different states
**Status:** Proposed — **flagged for review, see open question OQ-1**

**Context.** The brief's status list contains both. They are frequently conflated.

**Decision.** `Awaiting Hold Point Release` is the *normal* ITP gate: work reached
a nominated hold point and awaits release. `Held` is an *exception*: an authority
(client stop-work, NCR-driven hold, lapsed permit) has stopped the lot. They have
different guards, different exits, and different urgency in the ageing views.

**Consequences.** The lot register's "unreleased hold points" ageing view is not
polluted by stop-work events, and vice versa. If the reviewer intends a single
state, this collapses cleanly — the guards remain distinct as conditions.

---

### ADR-0013 — Audit log is written by database trigger from session GUCs
**Status:** Proposed

**Context.** §11 requires before/after values on every mutation and states this is
what wins ISO 9001 and client system audits. Application-level audit logging is
forgettable, and the one path that forgets is the one an auditor finds.

**Decision.** `AFTER INSERT OR UPDATE` triggers on every business table write
`audit_log_entry` with `to_jsonb(OLD)` / `to_jsonb(NEW)`. Request context (user,
IP, user agent, request id) is read from transaction-local GUCs set by the
connection wrapper. Reads are logged explicitly, but only for a small, defined
set of restricted classes plus every export — so the log stays queryable.

**Consequences.** Audit coverage is structural. Cost: roughly a 2× write
amplification and JSONB bloat on wide rows; mitigated by monthly range
partitioning and by detaching old partitions to cold storage rather than dropping
them.

---

### ADR-0014 — Offline sync is an idempotent operation log; signatures never auto-resolve
**Status:** Proposed

**Context.** §7 states last-write-wins is unacceptable for signatures.

**Decision.** The device uploads a `sync_batch` of `sync_operation` rows, each
with a client-generated `client_op_id` used as an idempotency key, so replay is
safe. Auto-resolution is permitted only for non-signature operations whose
changed fields are disjoint from the server's and whose state-machine guard still
passes. Anything else — two signatures on one subject, a signature whose
`subject_hash` no longer matches, a transition invalidated while offline — raises
a `sync_conflict` for human resolution, retaining both values.

**Consequences.** A field signature can be rejected by the server. That is
surfaced to the signer and the responsible engineer rather than silently
discarded, because a discarded signature is a compliance failure.

---

### ADR-0015 — Client and verifier users get a structurally different UI shell, driven by `access_grant.side`
**Status:** Proposed

**Context.** §2: "nobody signs on the wrong side of the fence."

**Decision.** `access_grant.side` is resolved at session start and drives the
application shell — different chrome, colour treatment, navigation and an
always-visible identity banner. It is not a theme toggle and not user-selectable.
The same value participates in signature eligibility guards (C9), so the visual
distinction and the enforcement share one source of truth.

**Consequences.** A user with memberships on both sides of a contract (rare but
real, e.g. a secondee) must switch context explicitly, and the switch is audited.

---

### ADR-0016 — Quantities and money are `numeric` with an explicit unit reference
**Status:** Proposed

**Context.** Lot quantities feed progress claims. Floating point in a claims chain
is indefensible.

**Decision.** `numeric(14,3)` for quantities with a `unit_id` FK to a unit table;
`numeric(14,2)` + ISO currency code for money. No floats anywhere in the
commercial or quantity path. Unit conversion is explicit and recorded, never
implicit.

**Consequences.** Slightly more schema ceremony; exact arithmetic in every
aggregate.

---

### ADR-0017 — Vector tiles are served from PostGIS, not pre-generated
**Status:** Proposed

**Context.** §6 requires 5,000 polygons panning at 60 fps, coloured by a status
that changes constantly. Pre-generated tiles would be stale the moment a
checkpoint is signed.

**Decision.** `ST_AsMVT` over the generated `geom_3857` column, with per-zoom
`ST_SimplifyPreserveTopology`, served through a tile route with a short cache TTL
and an ETag keyed on the project's maximum `updated_at`. RLS applies inside the
tile query, so a subcontractor's tiles contain only their own features — the
fence holds at the tile layer, not just the API.

**Consequences.** Tiles are always current and always correctly scoped. Cost:
tile queries hit the database; mitigated by the GiST index, the simplification
ladder, point clustering at low zoom, and edge caching keyed by user scope.
