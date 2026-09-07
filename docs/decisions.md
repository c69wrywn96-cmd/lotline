# Architecture Decision Records

Per §0 of the build brief: every judgement call made in the absence of an explicit
requirement is recorded here as a numbered ADR.

ADR-0001 through ADR-0005 and ADR-0006 through ADR-0017 were reviewed at design
review 1. ADR-0004 and ADR-0010 were amended there; ADR-0018 through ADR-0022 are
new and carry the review's answers.

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
**Status:** Accepted at design review 1, **amended** — this ADR governs the
horizontal only. Vertical position is ADR-0018.

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

**Consequences.** Storage triples for geometry columns. In exchange, a horizontal
datum dispute is resolvable from the record, quantities match the surveyor, and no
lot is silently 1.8 m out.

**Amendment (design review 1).** As originally written this solved horizontal
position and left vertical position as bare `rl_top_m` / `rl_bottom_m` numerics
with the datum inferred from `project.vertical_datum` — which is the same
unnamed-datum failure this ADR exists to prevent, one axis over. Vertical position
is now ADR-0018: an explicit attribute against a named datum, carried on the
record. Canonical `geom` is consequently **2D**; any Z ordinate in imported data
survives only in `geom_source` as provenance.

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

### ADR-0010 — Hold-point blocking is a database trigger; clearance is a signed record
**Status:** Accepted at design review 1, **amended** — hold and witness are now
structurally distinct, and clearance is record-based with three kinds.

**Context.** §13: "Do not let a hold point be bypassed by any role without a
recorded concession." §12.4 requires proof of blocking.

**Decision.** `itp_blocking_predecessor()` plus a `BEFORE UPDATE` trigger on
`itp_checkpoint` and a `BEFORE INSERT` trigger on `checkpoint_evidence`. No
permission, role, flag or environment variable suppresses either.

**Amendment (design review 1), two parts.**

*Hold and witness are structurally distinct.* Only a hold point blocks. A witness
point never does — work proceeds once the notice period elapses, whether or not
the client attends. This is now enforced by a CHECK constraint
(`blocking_scope = 'none' OR checkpoint_type = 'hold'`) on both the master and
instance checkpoint tables, so a witness point cannot be given a blocking scope by
any author at any level, **and** by the predicate filtering on
`checkpoint_type = 'hold'`, so the behaviour survives the constraint being
dropped. A Quality Manager who believes a witness point should stop work must
model it as a hold point — which is correct, and is visible to the client as such.

*Clearance is a record, not a flag.* The trigger asks whether a signed
`hold_release` row exists, not whether a status is set. `hold_release` carries a
`release_kind`:

| Kind | Supporting record | Signature requirement |
|---|---|---|
| `standard` | none | Nominated `release_role_id`, matching side |
| `concession` | `concession_id` | EM signature, plus client where the hold is client-nominated |
| `retrospective` | `retrospective_release_id` | **Identical to `standard`** |

This is what accommodates the two legitimate late paths the review identified —
retrospective release by the client, and correction of a mis-signed checkpoint —
without an override flag. See ADR-0019.

**Consequences.** Blocking is provable in `psql`, independent of the application,
and §12.4 is unaffected: the trigger has exactly one thing to look for, and that
thing is always signed. Emergency and late situations produce records rather than
exceptions to the rule.

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

---

### ADR-0018 — Vertical position is an explicit attribute against a named datum, never carried in geometry
**Status:** Accepted at design review 1

**Context.** Earthworks and pavement lots are defined by reduced level as much as
by plan position: subgrade at RL 32.450, SBC at RL 32.600, the same footprint
three times over. ADR-0004 solved the horizontal datum problem and left the
vertical one open — RLs were bare numerics with the datum inferred from a project
setting. Surveyors deliver levels against AHD; an unnamed level is not evidence,
and a level inferred from a project default is an assumption dressed as a fact.

Carrying RL inside the geometry does not fix it either. `geometry(PointZ, 7844)`
has a Z ordinate with **no defined vertical datum** — EPSG:7844 is a 2D geographic
CRS. Storing height there produces a number that looks authoritative and means
nothing without out-of-band knowledge, which is precisely the failure mode.

**Decision.**

1. Canonical `geom` is **2D**. Any Z in imported data survives in `geom_source`
   as provenance only.
2. A `vertical_datum` table names the datum: `AHD71` (mainland),
   `AHD_TAS83` (Tasmania), and local or assumed datums tied to a site benchmark —
   which are common enough on constrained sites to be worth modelling rather than
   forcing into a note.
3. Every reduced level anywhere in the system is a **pair**:
   `<name>_rl_m numeric(9,3)` plus `vertical_datum_id`, with
   `CHECK ((rl_m IS NULL) = (vertical_datum_id IS NULL))`. An RL without a named
   datum cannot be stored.
4. `project.default_vertical_datum_id` seeds new records. It is **never** consulted
   to interpret a stored RL.
5. Design, surveyed, deviation and tolerance are separate columns, so vertical
   conformance is computed from the record rather than asserted.
6. Level comparisons across two different `vertical_datum_id` values are rejected,
   not silently arithmetic.
7. `survey_conformance` additionally records `geoid_model`
   (`AUSGeoid2020` / `AUSGeoid09` / `none_direct_levelling`), because a
   GNSS-derived height is ellipsoidal until a geoid model converts it to AHD, and
   the difference between the two AUSGeoid realisations is decimetres — enough to
   fail a pavement layer that was built correctly.
8. Horizontal and vertical deviations and tolerances are tracked separately
   throughout, because they have different acceptance criteria.

**Consequences.** Every RL-bearing table carries an extra FK, and the lot raise
wizard has to ask for a datum — defaulted from the project, but stamped onto the
record. In exchange the layer cake is real: the vertical stack at a chainage is a
query, thickness conformance is computed against a named datum, and a level
dispute is resolvable from the record rather than from someone's memory of what
the surveyor was working to.

---

### ADR-0019 — The late paths are records, not overrides
**Status:** Accepted at design review 1

**Context.** ADR-0010 as first written admitted exactly one exit from a hold point
— a concession. The review identified two further paths that are real and routine:
a Quality Manager correcting a mis-signed checkpoint, and a client releasing a hold
point retrospectively after work has physically gone past it. Both must be
possible. Neither may be an override flag.

**Decision.** Both are modelled as signed records the blocking predicate accepts as
valid clearance.

*Retrospective release* (`hold_release.release_kind = 'retrospective'`). The
trigger was never bypassed: the block held, the site moved on, and the record is
being reconciled with what happened. The record captures when work actually
proceeded, the resulting lag, how the lapse was discovered, and — the field that
carries the engineering weight — `verification_basis`: how the releasing party
satisfied themselves the work was conforming once they could no longer see it
(`contemporaneous_evidence` / `physical_reinspection` / `destructive_verification`
/ `none`). Supporting evidence is mandatory unless the basis is `none`. The signer
must hold the nominated `release_role_id` on the correct side, exactly as for a
standard release — **lateness never relaxes who may sign.**

*Checkpoint correction* (`checkpoint_correction` + `signature_withdrawal`). Signed
rows are locked and signatures are immutable (ADR-0003), so correction is
supersession. The original checkpoint, its evidence and its signatures are all
retained; each withdrawn signature gets a `signature_withdrawal` that is itself
signed, with a reason. A replacement checkpoint is created at the same sequence.
**If the corrected checkpoint is a hold, its replacement has no clearance record
and re-blocks immediately** — a correction cannot be used to launder a hold point.

A retrospective release always raises a process NCR. Proceeding past an unreleased
hold point is a non-conformance under any QMS, and an ISO 9001 or client system
auditor expects to find it in the register. Proposed severity is `minor` where the
work was verified from contemporaneous evidence or reinspection, `major` where
destructive verification was needed or nothing verified it. Severity is proposed;
a human confirms.

**Consequences.** §12.4 is unaffected — the trigger has one thing to look for and
it is always signed. The paths engineers actually need exist, and using them leaves
a trail: `retrospective_lag` and `discovery_method` feed the trend engine, so a
crew that habitually outruns its hold points becomes visible instead of invisible.
The conformance pack's appendix carries every concession, retrospective release and
signature withdrawal against the lot — a lot that got to conformed the hard way
says so on the paper.

**Amendment (design review 2) — the NCR trigger branches on the decision time, not
on a contract setting.** A configurable switch was rejected: it gets turned off in
month two when the register looks embarrassing, and the record is then gone.
Worse, under TfNSW Q6 and most client QA specs a departure from the approved
quality system itself requires an NCR, so a tenant who switched it off would be in
breach of their own QMS — and we would have shipped the switch that put them
there.

The volume concern was real, but the flag was the wrong fix because it conflated
two genuinely different events:

- **(a) Administrative lag.** The release *decision* was made before work
  proceeded; only the signature was late. The Superintendent released verbally at
  the excavation and signed back in the office. The hold point did its job. This
  is not a non-conformance.
- **(b) Unreleased progression.** The release decision itself came after the work.
  Nobody cleared it at the time. This is a non-conformance by definition.

`retrospective_release` therefore records `release_decision_at` alongside
`work_proceeded_at` and the signature time, and the classification is a
**generated column**, not a user assertion:

```sql
lag_class GENERATED ALWAYS AS (
  CASE WHEN release_decision_at <= work_proceeded_at
            AND decision_evidence_kind <> 'none'
            AND (decision_witness_user_id IS NOT NULL
              OR decision_witness_name    IS NOT NULL
              OR decision_evidence_id     IS NOT NULL)
       THEN 'administrative_lag'
       ELSE 'unreleased_progression'
  END
) STORED
```

Claiming an administrative lag with nothing behind it does not fail — it
**degrades to `unreleased_progression`** and raises the NCR. The branch cannot be
self-asserted, and because the column is generated there is nothing to override.

An `administrative_lag` is logged, counted and surfaced in the ageing view. It
raises no NCR. An `unreleased_progression` raises one unconditionally.

Severity is then classified by `verification_basis` rather than suppressed:

| `verification_basis` | Severity | Closeout |
|---|---|---|
| `contemporaneous_evidence` | minor / process | Auto-populated, closeable with the release record as its own evidence. Low friction by design. |
| `physical_reinspection` | minor | Standard closeout. |
| `destructive_verification` | **major** | Someone cut into finished work. |
| `none` | **major** | EM disposition mandatory; cannot close as *Use As Is* without a client concession. If nobody can say how they satisfied themselves the work conformed, that is the whole problem, and recording it should be expensive. |

**The volume is the signal.** A project generating forty of these a month has a
systemic failure in hold point discipline, and the register is exactly where that
should become visible to the Quality Manager and the client. Suppressing the count
suppresses the only thing that would fix it.

---

### ADR-0020 — A joint venture shares one register; write authority is scoped by zone and WBS
**Status:** Accepted at design review 1 (resolves OQ-3)

**Context.** An unincorporated joint venture delivers one contract under one
quality management system with one ITP library. Partner-segregated QA data would
be a fiction — there is one lot register handed to the client. But JVs split work
geographically, and each partner's engineers own their sections.

**Decision.** `access_grant` separates read scope from write scope
(`grant_kind ∈ {read, write}`). A JV partner's Section Engineer holds
`read/project` and `write/zone` (or `write/wbs`). RLS `SELECT` policies resolve
against read grants; `INSERT` and `UPDATE` `WITH CHECK` clauses resolve against
write grants.

Zone and WBS scopes nest, so `scope_path` carries the subtree as `ltree` and
`lot` carries materialised `zone_path` and `wbs_path`. Containment is
`lot.wbs_path <@ g.scope_path` — a GiST probe, so write authority over WBS 3.2
covers 3.2.1.4 without enumeration and without a recursive subquery per row.

**This does not widen the external fence.** Project-wide read is issued only for
`contractor`, `client` and `verifier` side memberships. An `external` membership
(subcontractor, supplier) yields narrow grants for both kinds, and there is a
database-level assertion — plus a test — that no external membership ever produces
a `read/project` row.

**Consequences.** A JV partner can see another partner's zone and cannot write it;
the `USING` / `WITH CHECK` asymmetry means Postgres reports a policy violation
rather than hiding the row, so the UI can say "outside your assigned sections"
instead of "not found". Cross-partner reads are logged as cross-organisation
restricted reads, which partners will want visibility of. Cost: two grant rows per
membership instead of one, and an `ltree` column to maintain on `lot`.

---

### ADR-0021 — Four authentication patterns, and device trust is separate from user identity
**Status:** Accepted at design review 1 (resolves OQ-8)

**Context.** The supply chain does not have one identity story. Contractor staff
have Entra. Client agencies and independent verifiers have their own IdPs and
their security teams will not be guested into a vendor tenant. Subcontractors and
suppliers are frequently ten-person outfits with no enterprise identity at all —
gate them behind enterprise SSO and they will email PDFs instead, which defeats
the product. And site tablets are shared: a foreman will not complete an MFA
challenge thirty times a shift.

**Decision.** A single multi-tenant app registration, and four patterns:

1. **Contractor staff** — home tenant via the multi-tenant registration.
2. **Client and IV** — *both* federated OIDC (their own issuer, trusted directly
   via `org_identity_provider`, with home-realm discovery on email domain) *and*
   B2B guest. Whichever the agency's security posture permits.
3. **Subcontractors and suppliers** — local credentials (Argon2id) plus TOTP MFA.
4. **Field devices** — device trust plus per-user unlock.

The device pattern is the one that needs care. A device is **enrolled once as
trusted** by an authorised user under full MFA; that enrolment event is the strong
authentication the pattern rests on. A user's first unlock on that device requires
their **own** full authentication, recorded as `enrolment_auth_event_id` — so the
PIN is never a way to assert an identity that has not been verified. Thereafter
the user unlocks with a PIN or, preferably, a platform passkey (the biometric never
leaves the device and we get a cryptographic assertion rather than a shared
secret).

**The PIN maps to a user identity, not to the device. It is binding a signature.**
Every signature carries `authentication_event_id`, so the chain is traceable:
signature ← unlock ← that user's enrolment on this device ← the MFA login that
authorised it.

Two hard limits on device-bound sessions:

- **Step-up is required for hold point release** (every kind, retrospective
  included), conformance certification, client acceptance, concession approval,
  signature withdrawal, permit conflict override, and all administration. A device
  PIN is never sufficient for any of these; a passkey assertion or IdP
  re-authentication is.
- A device-bound session is **capability-restricted regardless of role**: no role
  management, no permission grants, no data export, no API keys, no IdP
  configuration. Intersected at session construction, before any permission check
  runs.

**Consequences.** `permission.min_auth_strength` becomes a column rather than
scattered conditionals. Four auth routes is more surface than one, and the device
enrolment flow is real work in Phase 1. In exchange the product is usable by the
whole supply chain rather than only by the head contractor's staff, and a signature
taken on a shared tablet is defensible in an audit.

---

### ADR-0022 — Client lot acceptance is contract-configurable and defaults to not required
**Status:** Accepted at design review 1 (resolves OQ-2, supersedes assumption A4)

**Context.** The original design required a client signature for a lot to reach
`Conformed`. Under most TfNSW and D&C arrangements that is wrong: the contractor
certifies conformance, and the Superintendent engages at hold points, witness
points, surveillance and audit rather than by signing every lot. On a 4,000-lot
package no Superintendent's Representative keeps up, and a register that waits for
them jams permanently.

**Decision.** `contract.client_lot_acceptance_mode` with three values:

- `not_required` — **the default.** `Ready for Review → Conformed` on contractor
  certification (G15).
- `nominated_work_types` — required only for work types listed in
  `contract_acceptance_work_type`; typically structural and geotechnical.
- `all` — required for every lot.

`client_accepted_at` and `client_acceptance_signature_id` are **attributes of a
conformed lot, not a state and not a gate.** Where acceptance is required they are
set at G16 in the same transaction as the transition. Where it is not, a
Superintendent accepting a batch during surveillance three weeks later sets them
via G19 with no state change at all. They are the only two columns writable after
a conformed lot locks, once only, `NULL → value`.

The client retains full authority over an already-conformed lot: `Conformed → Held`
(G5) on a surveillance stop-work, and `→ Non-Conforming` (G12) with an NCR. Nothing
about the default mode reduces client control; it removes the client from the
critical path without removing them from the process.

**Consequences.** The register never blocks on client throughput. The
§12.7 / §12.9 acceptance demonstration changes shape: the client's involvement is
shown at the hold and witness points, and the lot conforms on the contractor's
certification — which is what actually happens on a TfNSW package.

---

### ADR-0023 — Roles exist at two scope levels; org-scoped quality authority breaks the small-team deadlock
**Status:** Accepted at design review 2 (resolves OQ-19)

**Context.** As designed through review 1, every role was project-scoped and
`org_membership` was bare employment with no role attached. Segregation rules that
require a second eligible signatory — `signature_withdrawal` counter-signature
being the immediate case — therefore had to resolve inside a single project. On a
project with a two-person QA team, or where the only Quality Manager is the person
whose signature is being withdrawn, that deadlocks: the correction cannot be made
at all, which pushes people toward working around the record instead of through
it.

Contractors already solve this organisationally. A Tier 1 has a Group or Divisional
Quality Manager sitting above the projects, and quality authority genuinely does
escalate out of the project. The model just did not have a place to put them.

**Decision.** `role.scope_level ∈ {organisation, project}`.

- `org_membership` gains a nullable `role_id`. A null role is plain employment; a
  non-null role is a standing appointment at organisation level.
- An organisation-scoped membership materialises `access_grant` rows for **every
  project where that organisation is an active `project_participant`** — so a
  Group QM gains and loses project visibility automatically as the org's project
  portfolio changes, with no per-project administration. The projection trigger
  therefore fires on `project_participant` as well as on membership.
- Org-scoped grants are `read/project` plus `write/project`, narrowed by the role's
  permission bundle exactly as the Superintendent's Representative is — scope says
  *where*, permissions say *what*.
- Ships with one system template: **Group Quality Manager (GQM)**, contractor side,
  organisation scope. Holds project-wide read across the portfolio, the audit
  programme, the standards and acceptance-scheme libraries, audit log export, and
  the counter-signature permissions `signature.withdraw.countersign` and
  `checkpoint.correct.countersign`. It does **not** hold `lot.raise`,
  `checkpoint.sign` or any hold release permission — those are project
  nominations, and a group appointment is not a nomination.

Counter-signature eligibility for a `signature_withdrawal` is then: a user who is
**not the original signatory**, and who holds either `signature.withdraw` at
project level or `signature.withdraw.countersign` at organisation level. A
two-person team escalates to group QA rather than deadlocking.

**Consequences.** `access_grant` gains rows that are not traceable to a
`project_membership`, so the projection carries a `source` discriminator
(`project_membership` / `org_membership`) and the RLS tests assert both paths.
Org-scoped grants must be revoked promptly when a `project_participant` period
closes — handled by the same trigger, and tested. The external-membership
assertion from ADR-0020 is unaffected and is now enforced for both sources: no
`side='external'` membership of either kind can produce project-wide read.
