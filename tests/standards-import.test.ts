/**
 * The specification register importer (seed/standards/import.ts).
 *
 * The point of these tests is ADR-0006: the library takes identifiers, titles
 * and structure, and refuses the publisher's words. A register that carries
 * clause text is rejected, not silently stripped — silently stripping teaches
 * the next person that pasting the document is fine.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb } from './helpers';
import {
  validateRegister, topoSortClauses, importRegister, RegisterRejected,
  type RegisterInput,
} from '../seed/standards/import';

afterAll(async () => { await appDb.end(); });

/**
 * A structurally realistic register with INVENTED identifiers, used only to
 * exercise the importer. Real TfNSW numbering is not seeded from memory — see
 * seed/standards/README.md.
 */
const register = (): RegisterInput => ({
  body: { code: 'TESTBODY', name: 'Test Standards Body', jurisdiction: 'TEST' },
  retrievedFrom: 'https://example.invalid/register',
  retrievedAt: '2026-09-07T00:00:00Z',
  isPublicEdition: true,
  specifications: [
    {
      designation: 'TS 00000.1',
      title: 'Example Quality Management Specification',
      series: 'Q',
      versions: [
        {
          versionLabel: 'Ed 1 / Rev 1',
          effectiveFrom: '2026-01-01',
          clauses: [
            // deliberately out of order: children before parents
            { ref: '8.3.2', title: 'Example verification requirement', parent: '8.3',
              impliesHoldPoint: true, defaultNoticeHours: 24 },
            { ref: '8.3', title: 'Example inspection', parent: '8' },
            { ref: '8', title: 'Example section' },
            { ref: '8.4', title: 'Example witness requirement', parent: '8',
              impliesWitnessPoint: true, defaultNoticeHours: 48 },
          ],
        },
      ],
    },
  ],
});

describe('ADR-0006 is enforced by the importer, not by a policy note', () => {
  it('rejects a register carrying clause text, and says why', () => {
    for (const field of ['text', 'body', 'content', 'wording', 'clauseText', 'fullText']) {
      const bad = register();
      (bad.specifications[0]!.versions[0]!.clauses[0] as unknown as Record<string, unknown>)[field] =
        'The Contractor shall ensure that…';
      expect(() => validateRegister(bad), field).toThrow(RegisterRejected);
      expect(() => validateRegister(bad), field).toThrow(/ADR-0006/);
    }
  });

  it('the database also caps a tenant summary at a paraphrase length', async () => {
    await expect(
      asOwner(async (c) => {
        const ids = await c.query(`
          WITH b AS (INSERT INTO standards_body (code,name,jurisdiction)
                     VALUES ('CAPTEST','Cap Test','TEST') RETURNING id),
               s AS (INSERT INTO specification (standards_body_id,designation,title)
                     SELECT id,'CAP 1','Cap' FROM b RETURNING id),
               v AS (INSERT INTO specification_version (specification_id,version_label)
                     SELECT id,'Ed 1' FROM s RETURNING id)
          INSERT INTO clause (specification_version_id, clause_ref, title)
          SELECT id,'1','Cap clause' FROM v RETURNING id, specification_version_id`);
        const org = (await c.query(`SELECT id FROM organisation LIMIT 1`)).rows[0].id;
        return c.query(
          `UPDATE clause SET tenant_summary = repeat('x', 4000), tenant_summary_org_id = $2
            WHERE id = $1`,
          [ids.rows[0].id, org]);
      }),
    ).rejects.toThrow(/tenant_summary_is_a_paraphrase/);
  });

  it('a tenant summary must be attributed to the organisation that wrote it', async () => {
    await expect(
      asOwner(async (c) =>
        c.query(`UPDATE clause SET tenant_summary = 'our paraphrase' WHERE clause_ref = '1'`)),
    ).rejects.toThrow(/tenant_summary_is_attributed/);
  });

  it('there is no column anywhere in the library for source text', async () => {
    const cols = await asOwner(async (c) =>
      (await c.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name IN ('standards_body','specification','specification_version','clause')
            AND column_name ~ '(text|body|content|wording)$'`)).rows,
    );
    expect(cols).toEqual([]);
  });
});

describe('structural validation', () => {
  it('rejects a clause naming a parent that is not in the version', () => {
    const bad = register();
    bad.specifications[0]!.versions[0]!.clauses.push(
      { ref: '9.1', title: 'Orphan', parent: '9' });
    expect(() => validateRegister(bad)).toThrow(/names parent 9/);
  });

  it('rejects duplicate clause refs within one version', () => {
    const bad = register();
    bad.specifications[0]!.versions[0]!.clauses.push({ ref: '8.3', title: 'Duplicate' });
    expect(() => validateRegister(bad)).toThrow(/duplicate clause ref 8\.3/);
  });

  it('orders parents before children whatever order the file used', () => {
    const sorted = topoSortClauses(register().specifications[0]!.versions[0]!.clauses);
    const order = sorted.map((c) => c.ref);
    expect(order.indexOf('8')).toBeLessThan(order.indexOf('8.3'));
    expect(order.indexOf('8.3')).toBeLessThan(order.indexOf('8.3.2'));
  });

  it('detects a cycle rather than looping forever', () => {
    expect(() => topoSortClauses([
      { ref: 'a', title: 'A', parent: 'b' },
      { ref: 'b', title: 'B', parent: 'a' },
    ])).toThrow(/cycle/);
  });
});

describe('import', () => {
  it('builds the clause tree with provenance, and is idempotent', async () => {
    const first = await asOwner(async (c) => {
      await c.query('BEGIN');
      const s = await importRegister(c, register());
      await c.query('COMMIT');
      return s;
    });
    expect(first.clauses).toBe(4);
    expect(first.holdPointClauses).toBe(1);
    expect(first.witnessPointClauses).toBe(1);

    const tree = await asOwner(async (c) =>
      (await c.query(
        `SELECT clause_ref, path::text FROM clause c
           JOIN specification_version v ON v.id = c.specification_version_id
           JOIN specification s ON s.id = v.specification_id
          WHERE s.designation = 'TS 00000.1' ORDER BY path`)).rows,
    );
    expect(tree.map((r) => r.path)).toEqual(['c8', 'c8.c3', 'c8.c3.c2', 'c8.c4']);

    const prov = await asOwner(async (c) =>
      (await c.query(
        `SELECT retrieved_from, is_public_edition FROM specification_version v
           JOIN specification s ON s.id = v.specification_id
          WHERE s.designation = 'TS 00000.1'`)).rows[0],
    );
    expect(prov.retrieved_from).toBe('https://example.invalid/register');
    expect(prov.is_public_edition).toBe(true);

    // Re-importing a corrected register must not duplicate.
    const second = await asOwner(async (c) => {
      await c.query('BEGIN');
      const s = await importRegister(c, register());
      await c.query('COMMIT');
      return s;
    });
    expect(second.clauses).toBe(4);

    const total = await asOwner(async (c) =>
      (await c.query(
        `SELECT count(*)::int n FROM clause c
           JOIN specification_version v ON v.id = c.specification_version_id
           JOIN specification s ON s.id = v.specification_id
          WHERE s.designation = 'TS 00000.1'`)).rows[0].n,
    );
    expect(total).toBe(4);
  });

  it('hold- and witness-bearing clauses are indexed for ITP authoring', async () => {
    const gates = await asOwner(async (c) =>
      (await c.query(
        `SELECT clause_ref, implies_hold_point, implies_witness_point, default_notice_hours
           FROM clause c
           JOIN specification_version v ON v.id = c.specification_version_id
           JOIN specification s ON s.id = v.specification_id
          WHERE s.designation = 'TS 00000.1'
            AND (implies_hold_point OR implies_witness_point)
          ORDER BY clause_ref`)).rows,
    );
    expect(gates).toEqual([
      { clause_ref: '8.3.2', implies_hold_point: true, implies_witness_point: false, default_notice_hours: 24 },
      { clause_ref: '8.4',   implies_hold_point: false, implies_witness_point: true,  default_notice_hours: 48 },
    ]);
  });

  it('no real specification identifiers have been seeded', async () => {
    // Guards the claim in seed/standards/README.md. If someone later seeds a
    // register from memory rather than from the publisher, this fails.
    const bodies = await asOwner(async (c) =>
      (await c.query(`SELECT code FROM standards_body ORDER BY code`)).rows.map((r) => r.code),
    );
    expect(bodies.filter((b: string) => !['TESTBODY', 'CAPTEST'].includes(b))).toEqual([]);
  });
});
