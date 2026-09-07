# Specification register import

Per **ADR-0006**, this importer takes **identifiers, titles and structure only**.
There is no field for clause text, and the importer rejects a register that
carries one. `tenant_summary` is the contractor's own paraphrase and is authored
in the application, never imported from a publisher's document.

Use the **publicly published** specifications, not a project contract copy. In
most cases they are the same document, but the public edition carries no
contract-specific annexures, and there is no question about what we were
licensed to ingest. `is_public_edition` records which you used, and
`retrieved_from` / `retrieved_at` record provenance so an auditor asking "where
did this clause list come from" gets an answer.

## Format

`tfnsw-register.json` (or any file passed to the importer):

```jsonc
{
  "body": {
    "code": "TFNSW",
    "name": "Transport for NSW",
    "jurisdiction": "NSW",
    "website": "https://www.transport.nsw.gov.au/"
  },
  "retrievedFrom": "https://standards.transport.nsw.gov.au/…",
  "retrievedAt": "2026-09-07T00:00:00Z",
  "isPublicEdition": true,
  "specifications": [
    {
      "designation": "TS 01572.1",       // exactly as published — do not normalise
      "title": "Quality Management (Major Works)",
      "series": "Q",
      "disciplineHint": "quality",
      "sourceUrl": "https://…",
      "versions": [
        {
          "versionLabel": "Ed 1 / Rev 12",
          "effectiveFrom": "2021-06-01",
          "sourceUrl": "https://…",
          "clauses": [
            { "ref": "1",     "title": "General" },
            { "ref": "1.1",   "title": "Scope",  "parent": "1" },
            { "ref": "8.3.2", "title": "…", "parent": "8.3",
              "impliesHoldPoint": true, "defaultNoticeHours": 24 }
          ]
        }
      ]
    }
  ]
}
```

### Rules the importer enforces

- `ref` must be unique within a version, and any `parent` must appear in the same
  version. Parents are imported before children regardless of file order.
- `impliesHoldPoint` / `impliesWitnessPoint` are structural facts about the
  clause — that it creates an inspection obligation — not a reproduction of its
  wording.
- A clause object carrying `text`, `body`, `content` or `wording` is **rejected**
  with a pointer to ADR-0006. This is the mechanical guard against someone
  helpfully scraping the full document.
- Re-running is idempotent: existing specifications and versions are matched on
  their natural keys and clauses are upserted, so a corrected register can be
  re-imported without duplicating.

## Seed depth (design review 3)

- **Q6 — full clause tree.** It is the specification that structures every ITP,
  so the whole hierarchy earns its keep.
- **Earthworks, unbound pavement, drainage, bridge concrete — hold- and
  witness-bearing clauses only.** A complete clause tree for every construction
  specification is weeks of data entry that proves nothing extra in Phase 1.

## Running it

```bash
npm run db:standards -- seed/standards/tfnsw-register.json
```

## Status

**No register file is committed.** This environment's egress proxy blocks
`transport.nsw.gov.au` and `standards.transport.nsw.gov.au`, so the register
could not be pulled here, and specification numbering has demonstrably moved
(Q6 is now issued as `TS 01572.1`) — seeding from memory would be inventing
identifiers. Provide the file, or allowlist those hosts, and this becomes one
command.
