# 05 — Assumptions and open questions

**Status: awaiting your review (§14, item 4).**

Two lists. **Assumptions** are calls I have made and built into the design; they
need a "yes" or a correction. **Open questions** are ones where I cannot pick
sensibly without you, ordered by how much rework a late answer causes.

---

## A. Assumptions built into the design

| # | Assumption | Where it bites if wrong |
|---|---|---|
| A1 | A lot belongs to exactly one WBS element, one work type and one zone. Cross-zone work is split into multiple lots. | Lot table shape. Cheap to relax to a join table now, expensive later. |
| A2 | A lot has exactly one ITP instance. Multi-discipline work is multiple lots. | `itp_instance.lot_id` is unique. Structural. |
| A3 | A project has one governing MGA zone. Projects straddling a zone boundary declare a second `coordinate_system` row for import only. | ADR-0004. Import path. |
| A4 | Client acceptance is required for a lot to reach `Conformed`. | Guard G15. Some contracts conform on contractor signature alone — see OQ-2. |
| A5 | Witness-point waiver by non-attendance requires a *delivered* notification (a bounced email does not start the clock). | Guard C11. This is the conservative, claim-defensible reading. |
| A6 | A hold point release is never delegable, even by an explicit delegation. | `delegation.signature_delegable` is hard-false for this permission. |
| A7 | Subcontractors work inside the head contractor's ITP instance on the lot, attaching evidence against checkpoints assigned to them. They do not get their own parallel ITP. | Checkpoint-level `subcontract_package_id`. See OQ-9. |
| A8 | Suppliers never see lots, at all — not even the lot their delivery went into. They see their own dockets, certificates and the test results on their own supply. | RLS policy set. Deliberately stricter than "own scope". |
| A9 | Photos require a GPS fix to attach as *conformance* evidence; a photo without one may still be attached but is flagged and excluded from the pack's geo-referenced photo sheet. | Field module. See OQ-13. |
| A10 | Daily diaries lock at a configurable cut-off (default 48 h) after which changes are supersessions. | `daily_diary.locked_at`. |
| A11 | The retention horizon is defects liability period + 10 years, configurable per contract, and archive means detach-to-cold-storage, never drop. | Audit partitioning, export design. |
| A12 | "Approve NCR closeout > $50k" means the *cost impact* recorded on the NCR, using the greater of estimate and actual. | `constraint_json.max_cost_impact`. |
| A13 | Concrete lot acceptance is by structural element/pour lot, with supplier-side AS 1379 production compliance handled as a materials conformance record rather than as lot acceptance statistics. | Test module scope. See OQ-7. |
| A14 | Chainage ranges are half-open `[start, end)` so adjacent lots do not both claim the boundary chainage. | `numrange` semantics throughout. |
| A15 | Lot numbering sequences are allocated at `Draft → Open` (G1), not at draft creation, so abandoned drafts do not burn numbers. | Numbering scheme. Some clients require strict unbroken sequences — see OQ-11. |
| A16 | A project has one lot register shared by all JV partners; partner branding affects presentation and document headers, not data partitioning. | JV model. See OQ-3. |
| A17 | The public API is versioned (`/api/v1`), authenticated by scoped API keys tied to a service principal with its own `project_membership`, so API access obeys the same RLS. | Integration design. |
| A18 | `Superseded` is reachable from every non-terminal state and from `Conformed` only via the two-signature guard G17. | Lot state machine. |
| A19 | Voice-to-text and docket OCR are assistive: output is a draft field a human confirms before it becomes evidence. Nothing model-generated is ever signed. | §13 compliance. |
| A20 | WCAG 2.2 AA applies to the application and the marketing site. The map has a mandatory non-map equivalent (the table view) for every function, since a canvas map cannot be made AA-conformant on its own. | Phase 3 and 8 scope. |

---

## B. Open questions

Ordered by cost of a late answer.

### OQ-1 — Are `Held` and `Awaiting Hold Point Release` distinct states? *(blocks Phase 2 state machine)*
I have modelled them as distinct: the first is the normal ITP gate, the second is
an imposed stop-work (ADR-0012). If you intend one state, say so — the guards
stay the same but the enum and the ageing views collapse.

### OQ-2 — Is client acceptance mandatory for `Conformed`, or contract-configurable? *(blocks Phase 2)*
Guard G15 currently requires a client signature. On many TfNSW packages the
Superintendent accepts lots individually; on others the contractor conforms the
lot and the client audits a sample. If it is configurable I will add
`contract.requires_client_lot_acceptance` and branch G14/G15 on it. This changes
the acceptance-criteria demo in §12.7/§12.9.

### OQ-3 — In a joint venture, is the lot register shared or partitioned by partner? *(blocks Phase 1)*
"Separate user pools" is clear. "Separate branding" is clear. What is not clear is
whether JV partners see each other's lots. I have assumed one shared register
(A16) because the JV is a single legal deliverer to the client. If partners must
be fenced from each other, that is a different `access_grant` shape and needs
deciding now, not in Phase 3.

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

### OQ-8 — Microsoft Entra ID: one multi-tenant app registration, or a per-contractor single-tenant registration? And how do client, subcontractor and supplier users authenticate? *(blocks Phase 1)*
I have assumed a multi-tenant app registration with B2B guest access for client
and verifier users, and credentials-plus-MFA for subcontractors, suppliers and
field devices without corporate identities. Confirm — this is the first thing
built and it is expensive to change.

### OQ-9 — Do subcontractors ever hold their own ITPs, or always work within the head contractor's? *(affects Phase 2)*
A7 assumes the latter. Some packages (precast, specialist coatings) have the sub
running its own ITP that the head contractor surveils.

### OQ-10 — Hosting: AWS `ap-southeast-2`, Azure Australia East, or on a customer's own tenancy? *(blocks Phase 1 infrastructure)*
Affects object storage, virus scanning, the PDF worker fleet and how IRAP
alignment is argued. Government-funded infrastructure procurement will ask.

### OQ-11 — Do any target clients mandate strictly sequential, unbroken lot numbering?
A15 allocates numbers at raise, which can leave gaps if a lot is superseded. Some
client QA specs require an unbroken register with voided entries shown.

### OQ-12 — What is the required signature standard for hold point release?
Options, in increasing strength: click-to-sign with session binding; drawn
signature on glass; Entra re-authentication at the moment of signing. I have
modelled all three (`signature.signature_method`) and defaulted to
re-authentication for hold points and client acceptance. Confirm this is
proportionate, since it is friction on the most common client action.

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

## C. What I propose to build first, once this is signed off

Phase 1, in this order, ending in a demonstrable vertical slice:

1. Migrations for domain A (tenancy/identity/RBAC) and domain B (project
   structure/spatial framework), with PostGIS enabled from the first migration.
2. Database roles, `access_grant` triggers, RLS policies, the audit trigger, and
   the revoked-`DELETE` posture — with the §12.10-style SQL test suite green
   **before** any UI exists.
3. Auth.js with Entra ID + credentials, MFA, session→GUC binding in the Drizzle
   connection wrapper.
4. `can()` resolution, role template seeding, user and role management screens.
5. One seeded realistic project: contract, zones, alignment with real chainage,
   disciplines, WBS, work types, and users across every role — real rows, no
   fixtures pretending to be data.

Acceptance for Phase 1 is: the RLS test suite passes; every mutation appears in
`audit_log_entry` with before/after values; a subcontractor session returns zero
rows from tables outside its package; and `DELETE` fails as `lotline_app` on
every table.

**Nothing above is built yet. Waiting on your review of §14 items 1–4.**
