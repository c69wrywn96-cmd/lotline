# 00 — Domain glossary

Terms used precisely throughout the schema. Where Australian civil practice and
generic construction-software vocabulary disagree, Australian civil practice wins.

| Term | Definition as used in this system |
|---|---|
| **Lot** | A discrete, physically bounded parcel of work, of one work type, built to one specification, verified by one ITP instance, closed out with one conformance report. The atomic unit of compliance. Has geometry before it has paperwork. |
| **ITP** | Inspection & Test Plan. Ordered list of checkpoints with acceptance criteria, responsible parties and evidence requirements. |
| **Master ITP** | Library template, versioned, owned by the Quality Manager. |
| **ITP Instance** | Immutable snapshot of a specific Master ITP *version*, taken at lot raise, attached to exactly one lot. Later master revisions never touch it. |
| **Checkpoint** | One row of an ITP. Has a type (Hold / Witness / Surveillance / Review / Record). |
| **Hold Point** | A checkpoint that physically blocks progression. Work past it is not authorised until the nominated party releases it. Enforced in the database, not the UI. |
| **Witness Point** | A checkpoint where the client is notified N hours ahead and may attend. Work may proceed after the notice period elapses whether or not they attend. The non-attendance clock is evidence in a claim. |
| **Surveillance** | Client/IV may inspect at their discretion; no notice obligation, no block. |
| **Review** | Contractor-internal verification of a document or calculation. |
| **Record** | No inspection; an artefact must simply exist and be attached. |
| **Release** | The act by which a nominated party clears a hold point. Always signed. |
| **Waiver** | A witness point passing without client attendance after a validly logged notice period elapsed. Auto-computed, never auto-signed. |
| **Concession** | A documented, signed authority permitting work to proceed or be accepted outside the normal rule (e.g. accepting a lot with a failed test as *Use As Is*). Always creates a record; never a silent override. |
| **Conformance Pack** | The single assembled, indexed, bookmarked PDF proving a lot conforms. The deliverable to the client. |
| **NCR** | Non-Conformance Report. Raised when work, material or process does not meet specified requirements. |
| **Disposition** | The decision on what to do with a non-conformance: Rework / Repair / Use As Is / Reject and Remove. |
| **Chainage (CH)** | Distance in metres measured along a design alignment from its origin. Written `CH 1240`. Ranges written `CH 1240 – CH 1310`. |
| **Chainage equation** | A point where chainage is discontinuous (a "back" chainage meets a different "ahead" chainage) because the alignment was re-designed without re-chainaging. Common; ignoring it puts lots in the wrong place. |
| **Offset / side** | Perpendicular distance from the alignment centreline. `LHS` / `RHS` / `CL`, looking in the direction of increasing chainage. |
| **RL** | Reduced Level. Height above the vertical datum (AHD — Australian Height Datum). |
| **Layer cake** | The vertical stack of pavement lots at one location: subgrade → select fill → SBC → base → wearing course. Same footprint, different lots. |
| **WBS** | Work Breakdown Structure. Hierarchical scope decomposition; a Lot hangs off a WBS element. |
| **MGA2020** | Map Grid of Australia 2020, projected coordinates in metres, zones 49–56 (EPSG:7849–7856). What Australian survey data arrives as. |
| **GDA2020** | Geocentric Datum of Australia 2020, geographic (EPSG:7844). Differs from GDA94 by ~1.8 m — a defect-grade error if confused. |
| **Characteristic value** | The statistically-derived single value representing a lot's test results, used for acceptance. Not the mean, and not the worst individual result. Scheme varies by specification. |
| **NATA** | National Association of Testing Authorities. A test certificate is only admissible if the lab holds NATA accreditation for that method. |
| **Superintendent's Representative** | The client's on-site delegate. Releases hold points, accepts or rejects lots. Sits on the other side of the contract — must never be confused with a contractor user. |
| **IV / ITA** | Independent Verifier / Independent Technical Advisor. Read + sign, never edit. |
| **DBYD** | Dial Before You Dig. Utility plan enquiry; the certificate has an expiry date that permits depend on. |
| **SWMS** | Safe Work Method Statement. |
| **ESCP** | Erosion & Sediment Control Plan. |
| **WAE** | Work As Executed. The as-built handover pack. |
| **MDR** | Manufacturing/Master Data Record — the compiled handover documentation set. |
| **Supersede** | The only permitted form of deletion. The old record is retained, marked superseded, and linked to the record that replaces it, with a reason. |
| **Retrospective release** | A hold point released after work has physically proceeded past it. The block was never bypassed — the site moved on and the record is being reconciled. A signed record, not a flag, and always accompanied by a process NCR. |
| **Verification basis** | On a retrospective release, how the releasing party satisfied themselves the work was conforming once they could no longer see it: contemporaneous evidence, physical reinspection, destructive verification, or none. |
| **Checkpoint correction** | The Quality Manager's path to fix a mis-signed checkpoint. The original row, its evidence and its signatures are retained; a replacement is created at the same sequence. Correcting a released hold re-blocks it. |
| **Signature withdrawal** | Setting a signature aside without altering or deleting it. Itself signed, with a reason. An auditor sees a signature that happened and was later withdrawn. |
| **AHD71** | Australian Height Datum 1971 — the national vertical datum for mainland Australia. Tasmania uses AHD-TAS83. What surveyors deliver levels against. |
| **Vertical datum** | The named surface a reduced level is measured from. Held on every RL-bearing record, never inferred from a project setting, because an unnamed level is not evidence. |
| **AUSGeoid2020** | The geoid model that converts a GNSS-derived ellipsoidal height to an AHD height. The difference between it and the earlier AUSGeoid09 is decimetres — enough to fail a correctly built pavement layer. |
| **Device enrolment** | Registering a shared site device as trusted, performed once by an authorised user under full MFA. Separate from, and a precondition for, a user's per-device PIN or passkey unlock. |
| **Home-realm discovery** | Routing a login to the correct identity provider based on the user's email domain. How a client agency reaches their own IdP rather than being guested into a contractor tenant. |
| **Step-up** | Re-authentication at a higher strength (passkey assertion or IdP re-auth) demanded at the moment of a consequential action — releasing a hold point, certifying conformance, accepting a lot. A device PIN never satisfies it. |
