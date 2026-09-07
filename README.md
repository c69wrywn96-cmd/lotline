# Lotline

A geospatial, lot-based quality assurance and compliance platform for Australian
Tier 1 civil contractors.

Australian civil quality is **lot-based**: a Lot is a discrete, physically bounded
parcel of work, of one work type, built to one specification, verified by one
Inspection & Test Plan, and closed out with one Conformance Report. A Lot is a
shape on the ground before it is a piece of paper — so the geospatial layer is the
spine of the data model, not a bolt-on map view.

## Current status

**Design review round 1 complete — no application code written yet.**

Per §14 of the build brief, the schema, state machines and permission model are
reviewed before implementation begins. Round 1 amended ADR-0004 (vertical datum)
and ADR-0010 (hold vs witness blocking, record-based clearance) and added
ADR-0018 … ADR-0022.

| Document | Contents |
|---|---|
| [`docs/00-glossary.md`](docs/00-glossary.md) | Domain terms, used precisely throughout |
| [`docs/01-erd.md`](docs/01-erd.md) | Full data model as nine domain ERDs with entity descriptions |
| [`docs/02-state-machines.md`](docs/02-state-machines.md) | Lot, checkpoint, witness-notice, NCR, permit, pack and sync state machines, with every guard condition |
| [`docs/03-permission-matrix.md`](docs/03-permission-matrix.md) | 16 roles × ~90 permissions, with scope and constraint footnotes |
| [`docs/04-rls-and-enforcement.md`](docs/04-rls-and-enforcement.md) | Row-level security, immutability and audit enforcement — the mechanism behind acceptance criterion §12.10 |
| [`docs/decisions.md`](docs/decisions.md) | ADR-0001 … ADR-0017 |
| [`docs/05-assumptions-and-open-questions.md`](docs/05-assumptions-and-open-questions.md) | 20 assumptions and 17 open questions, ordered by cost of a late answer |

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
