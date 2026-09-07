# 05 — Assumptions and open questions

**Status: updated after design review 1.**

Two lists. **Assumptions** are calls I have made and built into the design.
**Open questions** are ones I cannot pick sensibly without you, ordered by how
much rework a late answer causes. Resolved items are struck through with the
answer recorded and the ADR that carries it.

---

## A. Assumptions built into the design

| # | Assumption | Where it bites if wrong |
|---|---|---|
| A1 | A lot belongs to exactly one WBS element, one work type and one zone. Cross-zone work is split into multiple lots. | Lot table shape. Cheap to relax to a join table now, expensive later. |
| A2 | A lot has exactly one ITP instance. Multi-discipline work is multiple lots. | `itp_instance.lot_id` is unique. Structural. |
| A3 | A project has one governing MGA zone. Projects straddling a zone boundary declare a second `coordinate_system` row for import only. | ADR-0004. Import path. |
| ~~A4~~ | ~~Client acceptance is required for a lot to reach `Conformed`.~~ **Superseded at review 1.** Contract-configurable, defaulting to *not required*: the contractor certifies, the client engages at hold points, witness points, surveillance and audit. | ADR-0022, guards G14–G16, G19. |
| A5 | Witness-point waiver by non-attendance requires a *delivered* notification (a bounced email does not start the clock). | Guard C11. This is the conservative, claim-defensible reading. |
| A6 | A hold point release is never delegable, even by an explicit delegation. | `delegation.signature_delegable` is hard-false for this permission. |
| A7 | Subcontractors work inside the head contractor's ITP instance on the lot, attaching evidence against checkpoints assigned to them. They do not get their own parallel ITP. | Checkpoint-level `subcontract_package_id`. See OQ-9, still open. |
| A8 | Suppliers never see lots, at all — not even the lot their delivery went into. They see their own dockets, certificates and the test results on their own supply. | RLS policy set. Deliberately stricter than "own scope". |
| A9 | Photos require a GPS fix to attach as *conformance* evidence; a photo without one may still be attached but is flagged and excluded from the pack's geo-referenced photo sheet. | Field module. See OQ-13. |
| A10 | Daily diaries lock at a configurable cut-off (default 48 h) after which changes are supersessions. | `daily_diary.locked_at`. |
| A11 | The retention horizon is defects liability period + 10 years, configurable per contract, and archive means detach-to-cold-storage, never drop. | Audit partitioning, export design. |
| A12 | "Approve NCR closeout > $50k" means the *cost impact* recorded on the NCR, using the greater of estimate and actual. | `constraint_json.max_cost_impact`. |
| A13 | Concrete lot acceptance is by structural element/pour lot, with supplier-side AS 1379 production compliance handled as a materials conformance record rather than as lot acceptance statistics. | Test module scope. See OQ-7. |
| A14 | Chainage ranges are half-open `[start, end)` so adjacent lots do not both claim the boundary chainage. | `numrange` semantics throughout. |
| A15 | Lot numbering sequences are allocated at `Draft → Open` (G1), not at draft creation, so abandoned drafts do not burn numbers. | Numbering scheme. Some clients require strict unbroken sequences — see OQ-11. |
| A16 | A project has one lot register shared by all JV partners; partner branding affects presentation and document headers, not data partitioning. **Confirmed at review 1**, with write authority scoped by zone/WBS. | ADR-0020. |
| A17 | The public API is versioned (`/api/v1`), authenticated by scoped API keys tied to a service principal with its own `project_membership`, so API access obeys the same RLS. | Integration design. |
| A18 | `Superseded` is reachable from every non-terminal state and from `Conformed` only via the two-signature guard G17. | Lot state machine. |
| A19 | Voice-to-text and docket OCR are assistive: output is a draft field a human confirms before it becomes evidence. Nothing model-generated is ever signed. | §13 compliance. |
| A20 | WCAG 2.2 AA applies to the application and the marketing site. The map has a mandatory non-map equivalent (the table view) for every function, since a canvas map cannot be made AA-conformant on its own. | Phase 3 and 8 scope. |

---

## B. Open questions

Ordered by cost of a late answer.

## B1. Resolved at design review 1

### OQ-1 — `Held` vs `Awaiting Hold Point Release` — ~~open~~ **kept distinct**
Retained as separate states (ADR-0012). `Awaiting Hold Point Release` is the
normal ITP gate; `Held` is an imposed stop-work. Different guards, different
exits, different urgency in the ageing views. `Held` is now also reachable from
`Conformed`, for a client finding a defect during surveillance.

### OQ-2 — Client acceptance — ~~open~~ **contract-configurable, default not required**
Three modes: `not_required` (default) / `nominated_work_types` / `all`.
`client_accepted_at` is an attribute of a conformed lot, set at G16 where
acceptance gates conformance and at G19 (no state change) where it does not.
The client keeps stop-work and non-conformance authority over already-conformed
lots. **ADR-0022.**

### OQ-3 — JV register — ~~open~~ **shared register, write scoped by zone/WBS**
One contract, one QMS, one ITP library, one register. `access_grant` splits read
from write; partners read project-wide and write their assigned zones and WBS
subtrees. External memberships never receive project-wide read, asserted in the
database and tested. **ADR-0020.**

### OQ-8 — Authentication — ~~open~~ **single multi-tenant registration, four patterns**
Contractor staff on home tenant; client and IV via *either* federated OIDC or B2B
guest; subcontractors and suppliers on local credentials plus TOTP; field devices
on trusted-device enrolment with per-user PIN or platform passkey. The PIN binds
to a user identity, not the device. Step-up is mandatory for hold release,
conformance certification, client acceptance and all administration; device-bound
sessions are capability-restricted regardless of role. **ADR-0021.**

### OQ-12 — Signature standard for hold release — ~~open~~ **resolved by ADR-0021**
Step-up: platform passkey assertion or IdP re-authentication. A device PIN is
never sufficient. Folded into `permission.min_auth_strength`.

---

## B2. Still open

### OQ-4 — Which specification suite do we build the library skeleton for first?
TfNSW (Q6 / R-series / B-series) is the largest market and the brief's examples
lean that way. Confirm, or name a different first target. This sets the seed data
for the Phase 1 realistic project.

### OQ-5 — Do you hold licences permitting k-factor tables and acceptance criteria to ship with the product? *(affects ADR-0007)*
I have assumed **no**, and designed for tenant-populated tables. If a licence
exists for any suite, that suite can ship populated and the onboarding burden
drops substantially.

### OQ-6 — Aerial imagery: is there a Nearmap or Metromap subscription, and what does its licence say about tile caching for offline use? *(blocks Phase 3 and Phase 6)*
Offline-first (§7) requires caching tiles on a device. Most aerial imagery
licences restrict this. Without an answer I will build against ESRI World
Imagery + uploaded orthomosaics for the offline path and treat Nearmap as
online-only, which is a materially worse field experience.

### OQ-7 — Is concrete accepted at lot level with characteristic-value statistics, or per AS 1379 production assessment at the supplier? *(affects Phase 4)*
Assumption A13 says the latter. This changes what §12.5's statistics module must
cover and whether the strength-gain curve feature drives acceptance or is
informational.

### OQ-9 — Do subcontractors ever hold their own ITPs, or always work within the head contractor's? *(affects Phase 2)*
A7 assumes the latter. Some packages (precast, specialist coatings) have the sub
running its own ITP that the head contractor surveils.

### OQ-10 — Hosting: AWS `ap-southeast-2`, Azure Australia East, or on a customer's own tenancy? *(blocks Phase 1 infrastructure)*
Affects object storage, virus scanning, the PDF worker fleet and how IRAP
alignment is argued. Government-funded infrastructure procurement will ask.

### OQ-11 — Do any target clients mandate strictly sequential, unbroken lot numbering?
A15 allocates numbers at raise, which can leave gaps if a lot is superseded. Some
client QA specs require an unbroken register with voided entries shown.

### OQ-13 — Should a photo without a GPS fix be rejected outright as conformance evidence?
A9 flags rather than rejects. Rejecting is cleaner evidentially but will be
fought by anyone working inside a structure or a tunnel where GPS is unavailable.

### OQ-14 — Is there a claims/progress-claim module in scope?
§5.3 says NCR cost and time impact "feed the claims module", but no claims module
is specified in §5. I have designed the NCR cost fields and an export interface,
and assumed the claims module itself is out of scope. Confirm.

### OQ-15 — SMS for hold point releases: required, and via which provider? *(Phase 2/6)*
§10 says "optional SMS". In Australia this needs a provider decision
(MessageMedia, Twilio AU, SNS) and sender-ID registration lead time.

### OQ-16 — For the Phase 8 public demo (§9.2), what sample project and imagery may be used?
The demo must be real data through real APIs (§0, §13) but must not use a real
client's project or licensed aerial imagery without permission. I propose a
synthetic-but-realistic demonstration project on open imagery, clearly labelled
as a demonstration. Confirm, and confirm there is no real project we may use.

### OQ-17 — Target device floor for the field PWA?
This sets the offline storage budget (aerial tiles are the bulk of it) and the
camera/GPS API surface. Assumed: mid-range Android from the last four years,
plus recent iOS, with a nominal 2 GB offline allowance per zone.

---

### OQ-18 — Retrospective release NCR — ~~open~~ **resolved: branch on decision time, no flag**
Not a contract switch. `retrospective_release` records `release_decision_at`
alongside `work_proceeded_at`; a **generated** `lag_class` column separates an
administrative lag (decision made in time, signature late — no NCR) from
unreleased progression (decision made after the fact — NCR, unconditional).
Claiming a lag without a witness or contemporaneous record degrades automatically
to unreleased progression. Severity is classified by `verification_basis`, not
suppressed. **ADR-0019, amended.**

### OQ-19 — Signature withdrawal counter-signature — ~~open~~ **resolved: org-scoped quality role**
The model did not have one; it does now. `role.scope_level` admits
`organisation`, `org_membership` carries a role, and a Group Quality Manager
template holds `signature.withdraw.countersign` across every project their
organisation participates in. A two-person QA team escalates instead of
deadlocking. **ADR-0023.**

### OQ-20 — Local and assumed vertical datums: how common on your target projects? *(new at review 1)*
`vertical_datum` supports local datums tied to a site benchmark (ADR-0018). If
these are rare, the UI can bury them; if they are common on constrained or tunnel
work, the lot raise wizard needs to surface datum selection more prominently than
I have currently scoped.

## C. Phase 1 build order

Nothing is built yet. On confirmation of the new material flagged in §B2
(OQ-18 especially), Phase 1 proceeds in this order, ending in a demonstrable
vertical slice:

1. Migrations for domain A (tenancy, identity, RBAC, device enrolment) and
   domain B (project structure, spatial framework, `vertical_datum`), with
   PostGIS and `ltree` enabled from the first migration.
2. Database roles; `access_grant` triggers including the read/write split and the
   external-membership assertion; RLS policies; the audit trigger; the
   revoked-`DELETE` posture — with the §12.10 and OQ-3 SQL test suites green
   **before** any UI exists.
3. Auth.js with all four patterns: home tenant, federated OIDC with home-realm
   discovery, local credentials plus TOTP, and device enrolment with per-user PIN
   or platform passkey. Session→GUC binding in the Drizzle connection wrapper,
   including `app.auth_event_id`.
4. `can()` resolution including `min_auth_strength` and the device-bound
   capability intersection; role template seeding; user, role and device
   management screens.
5. One seeded realistic project: contract with an acceptance mode, zones with
   `ltree` paths, an alignment with real chainage and equations, a named vertical
   datum, disciplines, WBS, work types, and users across every role and every
   authentication pattern — real rows, no fixtures pretending to be data.

Phase 1 acceptance:

- The RLS suite passes, including: a JV partner reads another partner's zone and
  cannot write it; no external membership yields a project-wide read grant; a
  subcontractor returns zero rows outside its package; a supplier returns zero
  lots.
- Every mutation appears in `audit_log_entry` with before/after values and its
  `auth_event_id`.
- `DELETE` fails as `lotline_app` on every table.
- A signature made on an enrolled shared device traces back through its
  `authentication_event` to the user's own MFA enrolment.
- No RL exists anywhere without a `vertical_datum_id`.

**What is still needed:** OQ-10 (hosting) gates Phase 1 *infrastructure* — object
storage, virus scanning, the worker fleet — but not the schema or the migrations,
so I can start without it. OQ-4 (first specification suite) gates the seed data in
step 5 and is needed by the end of Phase 1, not the start.
