# 03 — Permission matrix (role × action)

**Status: proposed, awaiting review.**

These are **system role templates**, not hardcoded tiers. A tenant clones a
template into its own `role` row and adjusts `role_permission` freely. Nothing in
the application branches on a role name; every check is
`can(user, 'permission.code', subject)` resolved against `role_permission`,
`permission_grant`, `delegation`, `access_grant` scope, and the constraint JSON.

## Legend

| Symbol | Meaning |
|---|---|
| `●` | Granted |
| `○` | Read only |
| `▲n` | Granted with condition — see footnote *n* |
| ` ` (blank) | Not granted |

## Roles and their default scope

| Code | Role | Side | Default scope | Notes |
|---|---|---|---|---|
| **PD** | Project Director | contractor | project | |
| **CM** | Construction Manager | contractor | project | |
| **EM** | Engineering Manager | contractor | project | |
| **QM** | Quality Manager | contractor | project | System configuration owner |
| **ENV** | Environmental / Sustainability Manager | contractor | project | |
| **WHS** | WHS Manager | contractor | project | Permit system owner |
| **SR** | Superintendent's Representative | **client** | project (read-mostly) | Distinct UI shell |
| **IV** | Independent Verifier / ITA | **verifier** | project (read + sign) | Distinct UI shell |
| **PE** | Package / Section Engineer | contractor | zone | |
| **SE** | Site / Project Engineer | contractor | zone | |
| **CAD** | Undergraduate / Cadet Engineer | contractor | zone | Cannot sign hold or witness points |
| **FMN** | Foreman / Supervisor | contractor | crew | Mobile-first |
| **SUR** | Surveyor | contractor | project | |
| **SUB** | Subcontractor | external | **package** | Row-level fenced from other subs |
| **SUP** | Supplier | external | **own deliveries** | Sees no lots at all |
| **AUD** | Client Stakeholder / Auditor | client | project | Read + export, zero write |

---

## 1. Lot

| Permission | PD | CM | EM | QM | ENV | WHS | SR | IV | PE | SE | CAD | FMN | SUR | SUB | SUP | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `lot.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲1 | | ● |
| `lot.create` | | ● | ● | ● | | | | | ● | ● | ● | | | | | |
| `lot.raise` | | ● | ● | ● | | | | | ● | ● | | | | | | |
| `lot.edit` | | ● | ● | ● | | | | | ● | ● | ▲2 | | | | | |
| `lot.geometry.edit` | | ● | ● | ● | | | | | ● | ● | ▲2 | | ● | | | |
| `lot.assign` | | ● | ● | ● | | | | | ● | | | | | | | |
| `lot.bulk_create` | | ● | ● | ● | | | | | ● | | | | | | | |
| `lot.submit` | | ● | ● | ● | | | | | ● | ● | | | | | | |
| `lot.closeout.approve` | ● | ● | | | | | | | | | | | | | | |
| `lot.accept` | | | | | | | ● | | | | | | | | | |
| `lot.reject` | | | | | | | ● | | | | | | | | | |
| `lot.hold.impose` | ● | ● | ● | ● | ▲3 | ▲3 | ● | ● | | | | | | | | |
| `lot.hold.lift` | ● | ● | ● | ● | ▲4 | ▲4 | ▲4 | ▲4 | | | | | | | | |
| `lot.determine_non_conforming` | | | ● | ● | | | ● | ● | | | | | | | | |
| `lot.supersede` | ▲5 | | ▲5 | ▲5 | | | | | | | | | | | | |
| `lot.export` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | | | ● | ▲1 | | ● |

## 2. ITP, checkpoints, holds and concessions

| Permission | PD | CM | EM | QM | ENV | WHS | SR | IV | PE | SE | CAD | FMN | SUR | SUB | SUP | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `itp.master.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲6 | | ● |
| `itp.master.author` | | | ● | ● | ▲3 | ▲3 | | | | | | | | | | |
| `itp.master.approve.technical` | | | ● | | | | | | | | | | | | | |
| `itp.master.publish` | | | | ● | | | | | | | | | | | | |
| `itp.master.withdraw` | | | | ● | | | | | | | | | | | | |
| `itp.instance.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲1 | | ● |
| `checkpoint.action` | | ● | ● | ● | ▲3 | ▲3 | | | ● | ● | ● | ● | ● | ▲1 | | |
| `checkpoint.evidence.attach` | | ● | ● | ● | ● | ● | | | ● | ● | ● | ● | ● | ▲1 | | |
| `checkpoint.sign` | | ● | ● | ● | ▲3 | ▲3 | | | ● | ● | **▲7** | ▲8 | ● | ▲1 | | |
| `checkpoint.hold.release` | | ▲9 | ▲9 | ▲9 | ▲9 | ▲9 | ▲9 | ▲9 | | | | | | | | |
| `checkpoint.witness.notify` | | ● | ● | ● | ● | | | | ● | ● | ● | | | | | |
| `checkpoint.witness.record_outcome` | | | | ▲10 | | | ● | ● | | | | | | | | |
| `checkpoint.mark_not_applicable` | | | ● | ● | | | | | | | | | | | | |
| `concession.request` | | ● | ● | ● | | | | | ● | ● | | | | | | |
| `concession.approve.em` | | | ● | | | | | | | | | | | | | |
| `concession.approve.client` | | | | | | | ● | | | | | | | | | |

> `checkpoint.sign` never permits signing a checkpoint whose `responsible_party`
> sits on the other side of the contract. A contractor role signing a
> client-nominated hold point is rejected by guard C9 regardless of permission.

## 3. Non-conformance

| Permission | PD | CM | EM | QM | ENV | WHS | SR | IV | PE | SE | CAD | FMN | SUR | SUB | SUP | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ncr.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲1 | | ● |
| `ncr.view.cost` | ● | ● | ● | ● | | | ▲11 | | | | | | | | | ▲11 |
| `ncr.raise` | ● | ● | ● | ● | ● | ● | | | ● | ● | ● | ● | ● | ▲1 | | |
| `ncr.raise.client` | | | | | | | ● | ● | | | | | | | | |
| `ncr.assign` | | ● | ● | ● | ● | ● | | | ● | | | | | | | |
| `ncr.rootcause.edit` | | ● | ● | ● | ● | ● | | | ● | ● | ● | | | ▲1 | | |
| `ncr.disposition.propose` | | ● | ● | ● | | | | | ● | | | | | | | |
| `ncr.disposition.approve.em` | | | ● | | | | | | | | | | | | | |
| `ncr.disposition.approve.client` | | | | | | | ● | | | | | | | | | |
| `ncr.action.complete` | | ● | ● | ● | ● | ● | | | ● | ● | ● | ● | | ▲1 | | |
| `ncr.verify` | | ● | ● | ● | ● | ● | ▲12 | ▲12 | ● | | | | | | | |
| `ncr.close` | | **▲13** | ▲13 | ▲13 | | | | | | | | | | | | |
| `ncr.close.high_value` | **●** | | | | | | | | | | | | | | | |
| `ncr.reject` | | ● | ● | ● | | | ▲14 | | | | | | | | | |

## 4. Testing and materials

| Permission | PD | CM | EM | QM | ENV | WHS | SR | IV | PE | SE | CAD | FMN | SUR | SUB | SUP | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `test.request.raise` | | ● | ● | ● | ● | | | | ● | ● | ● | | | ▲1 | | |
| `test.result.upload` | | | ● | ● | | | | | ● | ● | ● | | | ▲1 | ▲15 | |
| `test.result.supersede` | | | ● | ● | | | | | | | | | | | | |
| `test.acceptance.recompute` | | | ● | ● | | | | | ● | | | | | | | |
| `material.submit` | | ● | ● | ● | ● | | | | ● | ● | | | | ▲1 | ● | |
| `material.approve` | | | ● | ● | ▲3 | | ▲16 | | | | | | | | | |
| `docket.upload` | | ● | ● | ● | | | | | ● | ● | ● | ● | | ▲1 | ● | |
| `docket.verify` | | ● | ● | ● | | | | | ● | ● | | | | | | |
| `precast.register` | | ● | ● | ● | | | | | ● | ● | ● | | | ▲1 | ● | |
| `test.result.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲1 | ▲15 | ● |

## 5. Permits

| Permission | PD | CM | EM | QM | ENV | WHS | SR | IV | PE | SE | CAD | FMN | SUR | SUB | SUP | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `permit.view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲17 | | ● |
| `permit.type.configure` | | | | ▲18 | | ● | | | | | | | | | | |
| `permit.request` | | ● | ● | | ● | ● | | | ● | ● | ● | ● | | ▲17 | | |
| `permit.prerequisite.verify` | | ● | ● | | ● | ● | | | ● | ● | | | | | | |
| `permit.approve` | | **▲19** | ▲19 | | ▲19 | **▲19** | | | ▲19 | | | | | | | |
| `permit.conflict.override` | | ▲20 | | | | ● | | | | | | | | | | |
| `permit.signon` | | ● | ● | ● | ● | ● | | | ● | ● | ● | ● | ● | ● | | |
| `permit.suspend` | ● | ● | | | ● | ● | ▲21 | | | | | | | | | |
| `permit.close` | | ● | ● | | ● | ● | | | ● | ● | | ● | | | | |

## 6. Survey and the other registers

| Permission | PD | CM | EM | QM | ENV | WHS | SR | IV | PE | SE | CAD | FMN | SUR | SUB | SUP | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `survey.upload` | | | ● | ● | | | | | ● | ● | | | ● | ▲1 | | |
| `survey.verify` | | | ● | ● | | | ▲16 | ▲16 | | | | | ● | | | |
| `diary.create` | | ● | ● | ● | ● | ● | | | ● | ● | ● | ● | ● | | | |
| `diary.lock` | | ● | ● | ● | | | | | ● | | | | | | | |
| `site_instruction.issue` | | | | | | | ● | | | | | | | | | |
| `site_instruction.acknowledge` | ● | ● | ● | ● | | | | | ● | | | | | | | |
| `rfi.raise` | | ● | ● | ● | ● | ● | | | ● | ● | ● | | ● | ▲1 | | |
| `rfi.respond` | | | ● | | ● | ● | ● | | | | | | | | | |
| `design_change.propose` | | ● | ● | ● | | | | | ● | | | | | | | |
| `design_change.approve` | | | ● | | | | ▲16 | | | | | | | | | |
| `audit.schedule` | | | | ● | ▲3 | ▲3 | ▲22 | ▲22 | | | | | | | | |
| `audit.conduct` | | | | ● | ● | ● | ● | ● | | | | | | | | |
| `calibration.manage` | | | | ● | | ● | | | | | | | | ▲1 | | |
| `competency.view` | ● | ● | | ● | | ● | | | ▲23 | | | ▲23 | | ▲1 | | |
| `competency.manage` | | | | ● | | ● | | | | | | | | | | |
| `environment.incident.raise` | | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | | ▲1 | | |
| `subcontractor.scorecard.view` | ● | ● | ● | ● | | | ▲11 | | ● | | | | | | | |

## 7. Documents, signatures, packs and exports

| Permission | PD | CM | EM | QM | ENV | WHS | SR | IV | PE | SE | CAD | FMN | SUR | SUB | SUP | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `document.upload` | | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲1 | ▲15 | |
| `document.view.restricted` | ● | ● | ● | ● | ▲24 | ▲24 | ▲11 | | | | | | | | | ▲11 |
| `photo.capture` | | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲1 | | |
| `signature.sign` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ▲7 | ● | ● | ▲1 | | |
| `pack.generate` | ● | ● | ● | ● | | | ● | ● | ● | ● | ● | | | | | ● |
| `pack.batch_generate` | ● | ● | ● | ● | | | ● | ● | ● | | | | | | | ● |
| `wae.assemble` | | | ● | ● | | | | | | | | | | | | |
| `export.data` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | | | ● | ▲1 | ▲15 | ● |
| `export.audit_log` | ● | | | ● | | | ● | ● | | | | | | | | ● |
| `pc.sign` | **●** | | | | | | ▲25 | | | | | | | | | |

## 8. Administration

| Permission | PD | CM | EM | QM | ENV | WHS | SR | IV | PE | SE | CAD | FMN | SUR | SUB | SUP | AUD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `admin.project.configure` | ▲26 | | | ● | | | | | | | | | | | | |
| `admin.users.manage` | ▲26 | | | ● | | | | | | | | | | | | |
| `admin.roles.manage` | | | | ● | | | | | | | | | | | | |
| `admin.permission_grant.issue` | ● | | | ● | | | | | | | | | | | | |
| `admin.delegation.create` | ● | ● | ● | ● | ● | ● | ● | ● | | | | | | | | |
| `admin.standards.manage` | | | ● | ● | | | | | | | | | | | | |
| `admin.acceptance_scheme.manage` | | | ● | ● | | | | | | | | | | | | |
| `admin.integration.configure` | | | | ● | | | | | | | | | | | | |
| `api.key.manage` | | | | ● | | | | | | | | | | | | |

---

## Footnotes

1. **Subcontractor scoping.** Granted only for rows whose
   `subcontract_package_id` equals a package on the user's `access_grant`.
   Enforced by RLS, so it holds for the REST API, exports, vector tiles and
   direct SQL alike. A subcontractor cannot see another subcontractor's rows at
   any level, including aggregate counts.
2. **Cadet edit window.** Permitted only while `lot.status = 'Draft'`.
3. **Discipline-restricted.** ENV and WHS act only on checkpoints, ITPs, lots and
   materials whose `discipline_id` or checkpoint category is environmental /
   safety respectively.
4. **Symmetry of holds.** A hold may only be lifted by a role on the same side as
   the role that imposed it, or higher. A client- or verifier-imposed hold is not
   liftable by any contractor role.
5. **Superseding a lot.** Requires `lot.status != 'Conformed'`. Superseding a
   conformed lot (G17) requires an EM signature **and** a client signature; no
   single role can do it.
6. Subcontractors see master ITPs only for work types within their package scope.
7. **Cadet signature restriction — hard rule.** `checkpoint.sign` is granted for
   `surveillance`, `review` and `record` checkpoints only. Attempting to sign a
   `hold` or `witness` checkpoint is rejected by guard C6 even if a tenant
   mistakenly grants the permission — the constraint is on the checkpoint type,
   not the role.
8. Foreman may sign `record` and `surveillance` checkpoints and complete
   checklist evidence; not `hold`, `witness` or `review`.
9. **Hold release is nomination-driven.** The permission is necessary but not
   sufficient: guard C9 additionally requires the signer's active role to be the
   checkpoint's `release_role_id` and their `access_grant.side` to match the
   checkpoint's `responsible_party`. So a client hold point is releasable only by
   SR/IV, and a contractor hold point only by the nominated contractor role.
   Never delegable.
10. QM may record a witness outcome only to log a **client-communicated** outcome
    (e.g. a phone decline), and the record captures QM as recorder and the client
    contact as source. QM cannot record `attended`.
11. **Commercially sensitive.** Client-side and auditor roles see NCR cost and
    time impact only where the contract makes it disclosable
    (`contract.discloses_cost_impact`). Every read is written to
    `audit_log_entry` with `action='view_restricted'`.
12. Client/IV verification applies only to NCRs of `origin IN ('client','verifier')`.
13. **Value threshold.** Constrained by
    `role_permission.constraint_json.max_cost_impact` (default $50,000). An NCR
    whose `ncr_cost_impact.cost_amount` exceeds the approver's ceiling escalates
    to `ncr.close.high_value`.
14. Client may reject an NCR only where `origin='client'` — i.e. withdraw their
    own. A contractor rejecting a client NCR needs a client counter-signature (N9).
15. **Supplier scoping.** Granted only for rows where `supplier_org_id` equals the
    user's own organisation. Suppliers have **no** `lot.view` grant at all, so
    they cannot enumerate lots even indirectly; they see their dockets, mill
    certificates and the test results attached to their own supply.
16. Client review/approval rights here are contract-dependent
    (`contract.client_approves_materials`, `..._design_changes`,
    `..._survey`). Off by default; enabled per contract.
17. Subcontractors see and request permits only within their own package.
18. QM may configure permit types only for quality-related permit prerequisites;
    the permit system owner is WHS.
19. **Approval is step-typed.** `permit.approve` is evaluated against
    `permit_type_approval_step.required_role_id` for the specific step. WHS
    approves high-risk types (confined space, hot works, heights, lifting, rail
    access); CM/PE approve routine excavation and traffic control; ENV approves
    vegetation and environmental disturbance. High-risk steps additionally
    require a current `competency_record`.
20. CM may override a `warn`-severity conflict only. A `block`-severity conflict
    is overridable by WHS alone, with written justification and a signature, and
    the `permit_conflict_detection` row is retained showing the override.
21. Client may suspend a permit only where the contract grants stop-work
    authority.
22. Client and IV schedule their own audits; they cannot schedule the
    contractor's internal audit programme.
23. Section Engineers and Foremen see competency status (valid / expired) for
    people on their crew for sign-on purposes, **not** the underlying personal
    records. `competency_record.is_personal_sensitive` rows are excluded.
24. ENV and WHS access restricted documents within their own discipline only.
25. Client counter-signs Practical Completion; the contractor's signature is PD's.
26. Project Director may configure a project and manage users only where the
    tenant has not appointed a QM — the template ships with these off, so
    configuration authority is unambiguous.

---

## Resolution order

`can(user, permission, subject)` resolves in this order and stops at the first
denial:

1. **Session valid** — authenticated, MFA satisfied where the role requires it,
   session not expired.
2. **Row visibility (RLS).** If the subject row is not visible to this user, the
   answer is "not found", not "forbidden". Absence must not leak existence.
3. **Membership active** — `project_membership.active_period @> now()`.
4. **Scope** — subject's `zone_id` / `subcontract_package_id` / `crew_id` /
   `supplier_org_id` matches an `access_grant` row.
5. **Permission held** — via `role_permission`, or an unexpired
   `permission_grant`, or a `delegation` that includes the code.
6. **Constraint satisfied** — `constraint_json` evaluated against the subject
   (cost ceilings, discipline restriction, contract flags).
7. **State machine guard** — the transition's guard from `02-state-machines.md`.
8. **Signature eligibility** — side match, non-delegable check, cadet/foreman
   checkpoint-type restriction.

Steps 2, 7 and 8 are enforced **in the database**. The application layer's
`can()` exists to render the UI correctly and to return good error messages; it
is never the only barrier. A hostile client with a valid session and a raw SQL
connection still cannot release a hold point it is not nominated for.
