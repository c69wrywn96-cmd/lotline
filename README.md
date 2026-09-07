# Lotline

A geospatial, lot-based quality assurance and compliance platform for Australian
Tier 1 civil contractors.

Australian civil quality is **lot-based**: a Lot is a discrete, physically bounded
parcel of work, of one work type, built to one specification, verified by one
Inspection & Test Plan, and closed out with one Conformance Report. A Lot is a
shape on the ground before it is a piece of paper — so the geospatial layer is the
spine of the data model, not a bolt-on map view.

## Current status

**Phase 1 in progress.** Domains A (tenancy, identity, RBAC, devices) and B
(project structure, spatial framework, vertical datum) are migrated, seeded and
tested. **Phase 1 complete.** 186 tests green — RLS and immutability at SQL level against
`lotline_app`, the permission resolver, the authentication seam, credential
sign-in, account linking, and the device and people screens.

Design reviews 1 and 2 are complete; see `docs/decisions.md` for ADR-0001 …
ADR-0023.

```bash
./scripts/dev-db.sh      # Postgres 16 + PostGIS 3.4
npm install
npm run db:reset         # apply every migration to a fresh database
npm run db:seed          # one realistic JV project
npm test                 # 186 assertions across 13 suites
npm run build            # Next.js app (device enrolment screens)
```

### What the suite proves

| Suite | Proves |
|---|---|
| `tests/rls.test.ts` | §12.10 subcontractor isolation and the JV read/write split, **by query**. No application authorisation logic participates. |
| `tests/immutability.test.ts` | `DELETE` is refused by the database on every table; a locked row is frozen except its enumerated unfrozen columns. |
| `tests/audit.test.ts` | Every mutation is logged with before/after values and the full request context, including writes made by trigger cascade. |
| `tests/auth-device.test.ts` | A device cannot be trusted without a step-up MFA enrolment, and a PIN cannot bind an identity that was not independently verified. |
| `tests/spatial.test.ts` | MGA zone/SRID consistency, chainage equations, 2D-only canonical geometry, and that no RL column can exist without a `vertical_datum_id`. |
| `tests/permissions.test.ts` | The resolution order step by step, each refusal checked for the *right* reason. A rule that denies for the wrong reason will allow for the wrong reason later. |
| `tests/auth-logic.test.ts` | Home-realm discovery and authentication-strength derivation, as pure functions — no browser, no IdP, no server. |
| `tests/session-bridge.test.ts` | That strength is recomputed from the stored event rather than trusted from the client, and that a revoked device drops an already-open session. |
| `tests/identity-link.test.ts` | That the migration between authentication patterns is three-party and explicit, and that registering an identity provider never re-routes anyone on its own. |
| `tests/devices-ui.test.ts` | That an administrator cannot set a user's PIN, that device trust and user enrolment stay visibly separate states, and that revocation is immediate. |
| `tests/standards-import.test.ts` | That the specification importer takes identifiers and structure and **rejects** a register carrying clause text (ADR-0006). |
| `tests/credentials.test.ts` | That the sign-in form is not an enumeration oracle, that a TOTP code cannot be replayed inside its own window, that recovery codes are single-use and buy only a session, and that a retired credential cannot authenticate. |
| `tests/people-ui.test.ts` | That changing someone's authority requires step-up, that **nobody can grant themselves a role**, and that the change history is read from the audit log rather than a parallel table. |

| Document | Contents |
|---|---|
| [`docs/00-glossary.md`](docs/00-glossary.md) | Domain terms, used precisely throughout |
| [`docs/01-erd.md`](docs/01-erd.md) | Full data model as nine domain ERDs with entity descriptions |
| [`docs/02-state-machines.md`](docs/02-state-machines.md) | Lot, checkpoint, witness-notice, NCR, permit, pack and sync state machines, with every guard condition |
| [`docs/03-permission-matrix.md`](docs/03-permission-matrix.md) | 16 roles × ~90 permissions, with scope and constraint footnotes |
| [`docs/04-rls-and-enforcement.md`](docs/04-rls-and-enforcement.md) | Row-level security, immutability and audit enforcement — the mechanism behind acceptance criterion §12.10 |
| [`docs/decisions.md`](docs/decisions.md) | ADR-0001 … ADR-0017 |
| [`docs/05-assumptions-and-open-questions.md`](docs/05-assumptions-and-open-questions.md) | Assumptions and open questions, ordered by cost of a late answer |

## Layout

| Path | |
|---|---|
| `db/migrations/` | **The authoritative schema.** Hand-written SQL, applied once in order, hash-pinned. RLS policies, guard functions, generated columns and revoked privileges are the substance of the design and none of them round-trip through an ORM's schema differ. |
| `src/db/schema/` | Drizzle schema mirroring the migrations, for application-layer typing. It does not generate them. |
| `src/db/session.ts` | The only door to the database: a transaction bound to a caller identity via `SET LOCAL`. Obtaining a connection without one is not possible. |
| `src/auth/` | Permission resolution (a thin client over `auth.decide()` — the rules live in SQL, once), home-realm discovery, authentication-strength derivation, and the request→session bridge. |
| `src/app/devices/` | Device enrolment and management. All logic sits in `data.ts` and is tested directly, because this is the feature where a UI can quietly undermine the security model. |
| `src/app/people/` | User and role management, and the authority-change history. |
| `src/app/signin/` | Home-realm discovery as a screen: the address is entered first, and only the applicable route is offered. |
| `seed/standards/` | Specification register importer and its format. No register is committed — see the README there. |
| `seed/` | One realistic joint-venture project. Real rows through the real schema. |

Start with `docs/05-assumptions-and-open-questions.md` — the open questions there
are what block Phase 1.

## Intended stack

Next.js 15 (App Router, Server Components) · TypeScript strict · PostgreSQL 16 +
PostGIS 3.4 · Drizzle ORM with RLS enforced in the database · Auth.js (Entra ID +
credentials) · Tailwind + shadcn/ui with custom tokens · MapLibre GL JS over
PostGIS vector tiles · S3-compatible object storage (AU region) · BullMQ + Redis ·
Chromium + pdf-lib for conformance packs · Vitest + Playwright. Deployed in an
Australian region — data sovereignty is a procurement gate for government-funded
infrastructure.

## Principles this codebase holds to

- **No delete.** Ever. Correction is supersession, with a linked reason.
- **No mock data.** Every screen is wired to real data through real API routes.
- **The map is the data model**, not a view layer.
- **Hold points block. Witness points never do.** Enforced by a database trigger
  and a CHECK constraint, so a witness point cannot be given a blocking scope by
  anyone. Clearance is a signed record — standard, concession or retrospective —
  never a flag.
- **Every reduced level names its datum.** RL is an explicit attribute against
  AHD71 or a named local datum, never carried inside geometry. An unnamed level is
  not evidence.
- **No reproduction of Australian Standards or client specification text.** The
  library stores clause identifiers, titles and the contractor's own paraphrased
  acceptance criteria. There is no column for source text.
- **Authorisation is enforced below the application.** A valid session with a raw
  SQL connection still cannot see another subcontractor's lots or release a hold
  point it is not nominated for.
