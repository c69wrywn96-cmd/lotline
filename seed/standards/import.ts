/**
 * Specification register importer.
 *
 * Takes identifiers, titles and structure. Per ADR-0006 it will not take clause
 * text: a register carrying a text-bearing field is rejected rather than
 * silently stripped, because silently stripping teaches the next person that
 * pasting the document is fine.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

export interface ClauseInput {
  ref: string;
  title: string;
  parent?: string;
  impliesHoldPoint?: boolean;
  impliesWitnessPoint?: boolean;
  defaultNoticeHours?: number;
  externalUrl?: string;
}

export interface VersionInput {
  versionLabel: string;
  effectiveFrom?: string;
  sourceUrl?: string;
  clauses: ClauseInput[];
}

export interface SpecificationInput {
  designation: string;
  title: string;
  series?: string;
  disciplineHint?: string;
  sourceUrl?: string;
  versions: VersionInput[];
}

export interface RegisterInput {
  body: { code: string; name: string; jurisdiction: string; website?: string };
  retrievedFrom?: string;
  retrievedAt?: string;
  isPublicEdition?: boolean;
  specifications: SpecificationInput[];
}

/** Fields that would carry the publisher's words. Their presence is an error. */
const FORBIDDEN_TEXT_FIELDS = ['text', 'body', 'content', 'wording', 'clauseText', 'fullText'];

export class RegisterRejected extends Error {}

export function validateRegister(raw: unknown): RegisterInput {
  if (typeof raw !== 'object' || raw === null) throw new RegisterRejected('register must be an object');
  const reg = raw as RegisterInput;

  if (!reg.body?.code || !reg.body?.name || !reg.body?.jurisdiction) {
    throw new RegisterRejected('register.body requires code, name and jurisdiction');
  }
  if (!Array.isArray(reg.specifications) || reg.specifications.length === 0) {
    throw new RegisterRejected('register.specifications must be a non-empty array');
  }

  for (const spec of reg.specifications) {
    if (!spec.designation || !spec.title) {
      throw new RegisterRejected('every specification needs a designation and a title');
    }
    if (!Array.isArray(spec.versions) || spec.versions.length === 0) {
      throw new RegisterRejected(`${spec.designation}: at least one version is required`);
    }
    for (const version of spec.versions) {
      if (!version.versionLabel) {
        throw new RegisterRejected(`${spec.designation}: every version needs a versionLabel`);
      }
      const refs = new Set<string>();
      for (const clause of version.clauses ?? []) {
        if (!clause.ref || !clause.title) {
          throw new RegisterRejected(`${spec.designation} ${version.versionLabel}: every clause needs a ref and a title`);
        }
        for (const forbidden of FORBIDDEN_TEXT_FIELDS) {
          if (forbidden in (clause as unknown as Record<string, unknown>)) {
            throw new RegisterRejected(
              `${spec.designation} clause ${clause.ref} carries a "${forbidden}" field. ` +
              'The library stores identifiers, titles and structure only — never the text of a ' +
              'published standard or specification (ADR-0006). Remove the field and re-import.',
            );
          }
        }
        if (refs.has(clause.ref)) {
          throw new RegisterRejected(`${spec.designation} ${version.versionLabel}: duplicate clause ref ${clause.ref}`);
        }
        refs.add(clause.ref);
      }
      for (const clause of version.clauses ?? []) {
        if (clause.parent && !refs.has(clause.parent)) {
          throw new RegisterRejected(
            `${spec.designation} ${version.versionLabel}: clause ${clause.ref} names parent ` +
            `${clause.parent}, which is not in this version`,
          );
        }
      }
    }
  }
  return reg;
}

/** Parents before children, whatever order the file used. */
export function topoSortClauses(clauses: readonly ClauseInput[]): ClauseInput[] {
  const byRef = new Map(clauses.map((c) => [c.ref, c]));
  const out: ClauseInput[] = [];
  const done = new Set<string>();

  const visit = (clause: ClauseInput, seen: Set<string>): void => {
    if (done.has(clause.ref)) return;
    if (seen.has(clause.ref)) {
      throw new RegisterRejected(`clause hierarchy contains a cycle at ${clause.ref}`);
    }
    seen.add(clause.ref);
    if (clause.parent) {
      const parent = byRef.get(clause.parent);
      if (parent) visit(parent, seen);
    }
    seen.delete(clause.ref);
    done.add(clause.ref);
    out.push(clause);
  };

  for (const clause of clauses) visit(clause, new Set());
  return out;
}

export interface ImportSummary {
  body: string;
  specifications: number;
  versions: number;
  clauses: number;
  holdPointClauses: number;
  witnessPointClauses: number;
}

export async function importRegister(
  client: pg.Client | pg.PoolClient,
  register: RegisterInput,
): Promise<ImportSummary> {
  const reg = validateRegister(register);
  const summary: ImportSummary = {
    body: reg.body.code, specifications: 0, versions: 0, clauses: 0,
    holdPointClauses: 0, witnessPointClauses: 0,
  };

  const bodyId = (await client.query<{ id: string }>(
    `INSERT INTO standards_body (code, name, jurisdiction, website)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website
     RETURNING id`,
    [reg.body.code, reg.body.name, reg.body.jurisdiction, reg.body.website ?? null],
  )).rows[0]!.id;

  for (const spec of reg.specifications) {
    const specId = (await client.query<{ id: string }>(
      `INSERT INTO specification (standards_body_id, designation, title, series,
                                  discipline_hint, source_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (standards_body_id, designation)
         DO UPDATE SET title = EXCLUDED.title, series = EXCLUDED.series,
                       source_url = EXCLUDED.source_url
       RETURNING id`,
      [bodyId, spec.designation, spec.title, spec.series ?? null,
       spec.disciplineHint ?? null, spec.sourceUrl ?? null],
    )).rows[0]!.id;
    summary.specifications += 1;

    for (const version of spec.versions) {
      const versionId = (await client.query<{ id: string }>(
        `INSERT INTO specification_version (specification_id, version_label, effective_from,
                                            source_url, retrieved_from, retrieved_at,
                                            is_public_edition)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (specification_id, version_label)
           DO UPDATE SET effective_from = EXCLUDED.effective_from,
                         retrieved_from = EXCLUDED.retrieved_from,
                         retrieved_at   = EXCLUDED.retrieved_at
         RETURNING id`,
        [specId, version.versionLabel, version.effectiveFrom ?? null,
         version.sourceUrl ?? null, reg.retrievedFrom ?? null,
         reg.retrievedAt ?? null, reg.isPublicEdition ?? true],
      )).rows[0]!.id;
      summary.versions += 1;

      const idByRef = new Map<string, string>();
      for (const clause of topoSortClauses(version.clauses ?? [])) {
        const parentId = clause.parent ? idByRef.get(clause.parent) ?? null : null;
        const id = (await client.query<{ id: string }>(
          `INSERT INTO clause (specification_version_id, parent_clause_id, clause_ref, title,
                               implies_hold_point, implies_witness_point,
                               default_notice_hours, external_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (specification_version_id, clause_ref)
             DO UPDATE SET title = EXCLUDED.title,
                           implies_hold_point = EXCLUDED.implies_hold_point,
                           implies_witness_point = EXCLUDED.implies_witness_point,
                           default_notice_hours = EXCLUDED.default_notice_hours,
                           updated_at = now()
           RETURNING id`,
          [versionId, parentId, clause.ref, clause.title,
           clause.impliesHoldPoint ?? false, clause.impliesWitnessPoint ?? false,
           clause.defaultNoticeHours ?? null, clause.externalUrl ?? null],
        )).rows[0]!.id;
        idByRef.set(clause.ref, id);
        summary.clauses += 1;
        if (clause.impliesHoldPoint) summary.holdPointClauses += 1;
        if (clause.impliesWitnessPoint) summary.witnessPointClauses += 1;
      }
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run db:standards -- <register.json>');
    console.error('See seed/standards/README.md for the format and for why no register is committed.');
    process.exit(2);
  }
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL_OWNER
      ?? 'postgres://postgres:postgres@localhost:5432/lotline',
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    const summary = await importRegister(client, JSON.parse(readFileSync(file, 'utf8')));
    await client.query('COMMIT');
    console.log(`Imported ${summary.body}:`);
    console.log(`  specifications      ${summary.specifications}`);
    console.log(`  versions            ${summary.versions}`);
    console.log(`  clauses             ${summary.clauses}`);
    console.log(`  hold-point clauses  ${summary.holdPointClauses}`);
    console.log(`  witness clauses     ${summary.witnessPointClauses}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('import.ts')) {
  main().catch((e) => {
    console.error(e instanceof RegisterRejected ? `Register rejected: ${e.message}` : e);
    process.exit(1);
  });
}
