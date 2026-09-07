/**
 * Row-level security.
 *
 * Acceptance criterion §12.10 asks for proof with a QUERY, not a UI screenshot.
 * Every assertion here is a row count or a database error, run as lotline_app
 * with RLS in force. No application authorisation logic participates.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { as, asOwner, countAs, appDb, userId, USERS, APP_URL, READONLY_URL } from './helpers';
import { Database, isWriteScopeViolation } from '../src/db/session';

afterAll(async () => {
  await appDb.end();
});

describe('database role posture', () => {
  it('no application role can bypass RLS or is a superuser', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
            WHERE rolname IN ('lotline_app','lotline_worker','lotline_readonly')
            ORDER BY rolname`,
        )
      ).rows,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.rolbypassrls, `${r.rolname} must not bypass RLS`).toBe(false);
      expect(r.rolsuper, `${r.rolname} must not be superuser`).toBe(false);
    }
  });

  it('lotline_app does not own any table (an owner bypasses RLS regardless)', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT tablename FROM pg_tables
            WHERE schemaname='public' AND tableowner IN ('lotline_app','lotline_worker','lotline_readonly')`,
        )
      ).rows,
    );
    expect(rows).toEqual([]);
  });

  it('every public table has RLS enabled AND forced, bar two documented exemptions', async () => {
    // access_grant and audit_log_entry are maintained by SECURITY DEFINER
    // triggers running as the owner, so they are ENABLE but NO FORCE (0011).
    // Every application role is a non-owner and remains fully policed.
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p')
              AND c.relname NOT IN ('spatial_ref_sys','geography_columns','geometry_columns')
              AND c.relname NOT LIKE 'audit_log_entry_%'
              AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
            ORDER BY c.relname`,
        )
      ).rows,
    );
    expect(rows.map((r) => r.relname)).toEqual(['access_grant', 'audit_log_entry']);
    // ...and both must still have RLS ENABLED, or the exemption is a hole.
    for (const r of rows) expect(r.relrowsecurity, `${r.relname}`).toBe(true);
  });

  it('the two exempt tables are unwritable by the application anyway', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT table_name, privilege_type FROM information_schema.role_table_grants
            WHERE table_schema='public'
              AND table_name IN ('access_grant','audit_log_entry')
              AND grantee IN ('lotline_app','lotline_worker','lotline_readonly')
              AND privilege_type IN ('UPDATE','DELETE')`,
        )
      ).rows,
    );
    expect(rows).toEqual([]);
  });
});

describe('fail closed', () => {
  it('an unset app.user_id yields zero rows everywhere', async () => {
    // Deliberately bypasses withSession, which would refuse an empty userId.
    const raw = new (await import('pg')).default.Client({ connectionString: APP_URL });
    await raw.connect();
    try {
      await raw.query('BEGIN');
      for (const table of ['project', 'zone', 'wbs_element', 'user_account', 'access_grant']) {
        const r = await raw.query(`SELECT count(*)::int n FROM ${table}`);
        expect(r.rows[0].n, `${table} must be empty without an identity`).toBe(0);
      }
      await raw.query('COMMIT');
    } finally {
      await raw.end();
    }
  });

  it('withSession refuses to run without a user id', async () => {
    await expect(
      appDb.withSession({ userId: '' }, async (db) => db.query('SELECT 1')),
    ).rejects.toThrow(/anonymous/i);
  });
});

describe('§12.10 — subcontractor isolation, proved by query', () => {
  it('a subcontractor sees only their own package, across every fenced table', async () => {
    // Vellacott hold P1-EARTH; Rowe hold P2-DRAIN. Neither may see the other.
    const vellacottPkgs = await as<{ package_code: string }>(
      USERS.subEarth,
      'SELECT package_code FROM subcontract_package ORDER BY package_code',
    );
    expect(vellacottPkgs.map((p) => p.package_code)).toEqual(['P1-EARTH']);

    const rowePkgs = await as<{ package_code: string }>(
      USERS.subDrain,
      'SELECT package_code FROM subcontract_package ORDER BY package_code',
    );
    expect(rowePkgs.map((p) => p.package_code)).toEqual(['P2-DRAIN']);
  });

  it('a subcontractor sees no zones, no WBS and no memberships', async () => {
    expect(await countAs(USERS.subEarth, 'zone')).toBe(0);
    expect(await countAs(USERS.subEarth, 'wbs_element')).toBe(0);
    expect(await countAs(USERS.subEarth, 'project_membership')).toBe(0);
  });

  it('a subcontractor sees no audit log entries', async () => {
    expect(await countAs(USERS.subEarth, 'audit_log_entry')).toBe(0);
  });

  it('a supplier sees no lots-adjacent project structure at all', async () => {
    expect(await countAs(USERS.supplier, 'zone')).toBe(0);
    expect(await countAs(USERS.supplier, 'wbs_element')).toBe(0);
    expect(await countAs(USERS.supplier, 'subcontract_package')).toBe(0);
    expect(await countAs(USERS.supplier, 'work_type')).toBe(0);
  });

  it('a subcontractor cannot see another organisation via user_account', async () => {
    const names = (await as<{ full_name: string }>(
      USERS.subEarth,
      'SELECT full_name FROM user_account ORDER BY full_name',
    )).map((n) => n.full_name);

    // Asserted in BOTH directions. Until migration 0017 this test passed
    // trivially, because user_account visibility had collapsed to self-only:
    // the list contained one name, so it "did not contain" the other
    // subcontractor for entirely the wrong reason. A register must be able to
    // render a signatory's name, so the positive half is the real guard.
    expect(names, 'they must see themselves').toContain('Tomas Vellacott');
    expect(names, 'and the contractor staff they share a project with')
      .toContain('Priya Nandakumar');
    expect(names, 'but never another subcontractor').not.toContain('Hana Rowe');
  });

  it('a user shares no visibility with someone on a project they are not on', async () => {
    // auth.shares_project_with must be a genuine predicate, not a constant.
    const shares = await as<{ ok: boolean }>(
      USERS.subEarth,
      `SELECT auth.shares_project_with(
                (SELECT id FROM user_account WHERE email = $1)) AS ok`,
      [USERS.qm],
    );
    expect(shares[0]?.ok).toBe(true);

    const orphan = await asOwner(async (c) => {
      const org = (await c.query(`SELECT id FROM organisation LIMIT 1`)).rows[0].id;
      return (await c.query(
        `INSERT INTO user_account (email, full_name, status, primary_org_id, auth_pattern)
         VALUES ('unrelated@example.invalid','Unrelated Person','active',$1,'local_credentials')
         ON CONFLICT DO NOTHING
         RETURNING id`, [org])).rows[0]?.id
        ?? (await c.query(`SELECT id FROM user_account WHERE email='unrelated@example.invalid'`)).rows[0].id;
    });

    const none = await as<{ ok: boolean }>(
      USERS.subEarth, `SELECT auth.shares_project_with($1::uuid) AS ok`, [orphan]);
    expect(none[0]?.ok).toBe(false);

    const visible = await as<{ n: string }>(
      USERS.subEarth,
      `SELECT count(*)::text n FROM user_account WHERE email = 'unrelated@example.invalid'`);
    expect(Number(visible[0]!.n)).toBe(0);
  });
});

describe('OQ-3 / ADR-0020 — joint venture reads wide, writes narrow', () => {
  it('a JV partner engineer reads the whole project including the other partner zone', async () => {
    const zones = await as<{ code: string }>(
      USERS.peA,
      'SELECT code FROM zone ORDER BY code',
    );
    // Jarrah writes Zone 3 only, but must SEE Zone 5 — the register, the map and
    // the export are project-wide.
    expect(zones.map((z) => z.code)).toContain('Z5');
    expect(zones.map((z) => z.code)).toContain('Z3');
  });

  it('a JV partner engineer cannot write the other partner zone', async () => {
    const uid = await userId(USERS.peA);
    await expect(
      appDb.withSession({ userId: uid }, async (db) =>
        db.query(`UPDATE zone SET name = 'hijacked' WHERE code = 'Z5'`),
      ),
    ).rejects.toSatisfy(isWriteScopeViolation);
  });

  it('a JV partner engineer can write their own zone', async () => {
    const uid = await userId(USERS.peA);
    const updated = await appDb.withSession({ userId: uid }, async (db) => {
      const r = await db.query(
        `UPDATE zone SET name = 'Zone 3 — CH 1200 to CH 1600 (revised)'
          WHERE code = 'Z3' RETURNING code`,
      );
      return r.rowCount;
    });
    expect(updated).toBe(1);
  });

  it('a write scope over a WBS element covers its whole subtree', async () => {
    // Grant Jarrah write over WBS 3.2 and confirm it reaches 3.2.1.4, two levels
    // down, via ltree containment rather than enumeration.
    const uid = await userId(USERS.peA);
    const proj = await asOwner(async (c) => (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    const wbs32 = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM wbs_element WHERE wbs_code='3.2'`)).rows[0].id);

    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership SET write_scope_type='wbs', write_scope_id=$1
          WHERE user_id=$2 AND project_id=$3`,
        [wbs32, uid, proj],
      );
    });

    const updated = await appDb.withSession({ userId: uid }, async (db) => {
      const r = await db.query(
        `UPDATE wbs_element SET description = description WHERE wbs_code = '3.2.1.4' RETURNING id`,
      );
      return r.rowCount;
    });
    expect(updated).toBe(1);

    // ...and does not reach a sibling subtree.
    await expect(
      appDb.withSession({ userId: uid }, async (db) =>
        db.query(`UPDATE wbs_element SET description = description WHERE wbs_code = '5.1'`),
      ),
    ).rejects.toSatisfy(isWriteScopeViolation);

    // restore
    const z3 = await asOwner(async (c) => (await c.query(`SELECT id FROM zone WHERE code='Z3'`)).rows[0].id);
    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership SET write_scope_type='zone', write_scope_id=$1
          WHERE user_id=$2 AND project_id=$3`,
        [z3, uid, proj],
      );
    });
  });

  it('THE FENCE: no external membership ever yields a project-wide grant', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT user_id, grant_kind FROM access_grant
            WHERE side = 'external' AND scope_type = 'project'`,
        )
      ).rows,
    );
    expect(rows).toEqual([]);
  });

  it('the fence is a constraint, not a convention — the row cannot be inserted', async () => {
    await expect(
      asOwner(async (c) => {
        const u = (await c.query(`SELECT id FROM user_account WHERE email=$1`, [USERS.subEarth])).rows[0].id;
        const p = (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id;
        return c.query(
          `INSERT INTO access_grant (user_id, project_id, grant_kind, scope_type, side, source, source_id)
           VALUES ($1,$2,'read','project','external','project_membership',$1)`,
          [u, p],
        );
      }),
    ).rejects.toThrow(/external_never_project_scope/);
  });

  it('an external role cannot be configured to grant project-wide read', async () => {
    await expect(
      asOwner(async (c) =>
        c.query(`UPDATE role SET grants_project_wide_read = true WHERE code = 'SUB'`),
      ),
    ).rejects.toThrow(/external_never_project_wide/);
  });
});

describe('ADR-0023 — organisation-scoped quality authority', () => {
  it('a Group QM reads the project without any project_membership', async () => {
    const memberships = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT count(*)::int n FROM project_membership pm
             JOIN user_account u ON u.id = pm.user_id WHERE u.email = $1`,
          [USERS.gqm],
        )
      ).rows[0].n,
    );
    expect(memberships).toBe(0);

    const zones = await countAs(USERS.gqm, 'zone');
    expect(zones).toBeGreaterThan(0);
  });

  it('the grant is sourced from org_membership, not project_membership', async () => {
    const rows = await as<{ source: string }>(
      USERS.gqm,
      `SELECT DISTINCT source FROM access_grant WHERE user_id = auth.user_id()`,
    );
    expect(rows.map((r) => r.source)).toEqual(['org_membership']);
  });

  it('org-scoped access follows participation: closing it revokes the grant', async () => {
    const before = await countAs(USERS.gqm, 'zone');
    expect(before).toBeGreaterThan(0);

    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_participant SET active_period = daterange(lower(active_period), CURRENT_DATE, '[)')
          WHERE organisation_id = (SELECT primary_org_id FROM user_account WHERE email = $1)
            AND participation = 'lead_contractor'`,
        [USERS.gqm],
      );
    });

    expect(await countAs(USERS.gqm, 'zone')).toBe(0);

    // restore
    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_participant SET active_period = daterange(lower(active_period), NULL, '[)')
          WHERE organisation_id = (SELECT primary_org_id FROM user_account WHERE email = $1)
            AND participation = 'lead_contractor'`,
        [USERS.gqm],
      );
    });
    expect(await countAs(USERS.gqm, 'zone')).toBeGreaterThan(0);
  });

  it('OQ-19: a withdrawal counter-signatory exists even when the project QM is the signatory', async () => {
    const proj = await asOwner(async (c) => (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    const qm = await userId(USERS.qm);

    const eligible = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT user_id, via FROM auth.eligible_withdrawal_countersignatories($1, $2)`,
          [proj, qm],
        )
      ).rows,
    );

    // The QM themselves must not appear...
    expect(eligible.map((e) => e.user_id)).not.toContain(qm);
    // ...and the org-level route must be available, which is the whole point:
    // a two-person QA team escalates instead of deadlocking.
    expect(eligible.some((e) => e.via === 'organisation')).toBe(true);
  });
});

describe('read-only role', () => {
  it('lotline_readonly is subject to the same policies and cannot write', async () => {
    const ro = new Database(READONLY_URL);
    try {
      const uid = await userId(USERS.subEarth);
      const rows = await ro.withSession({ userId: uid }, async (db) => {
        const r = await db.query<{ n: string }>(`SELECT count(*)::text n FROM zone`);
        return r.rows;
      });
      expect(Number(rows[0]!.n)).toBe(0);

      await expect(
        ro.withSession({ userId: uid }, async (db) =>
          db.query(`UPDATE zone SET name='x' WHERE true`),
        ),
      ).rejects.toThrow();
    } finally {
      await ro.end();
    }
  });
});

describe('multi-role membership (regression, migration 0013)', () => {
  it('a user may hold two roles on one project without colliding grants', async () => {
    // An Engineering Manager acting as Construction Manager is ordinary cover.
    // Before 0013 the second membership violated access_grant_pkey.
    const projectId = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    const uid = await userId(USERS.em);

    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO project_membership (project_id, user_id, role_id, write_scope_type)
         VALUES ($1,$2,(SELECT id FROM role WHERE code='CM' AND owner_org_id IS NULL),'project')`,
        [projectId, uid],
      );
    });

    const grants = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT grant_kind, scope_type FROM access_grant
            WHERE user_id=$1 AND project_id=$2 ORDER BY grant_kind`,
          [uid, projectId],
        )
      ).rows,
    );
    expect(grants).toEqual([
      { grant_kind: 'read', scope_type: 'project' },
      { grant_kind: 'write', scope_type: 'project' },
    ]);

    // Retiring ONE of the two roles must not strip access the other still
    // confers — the failure mode that ON CONFLICT DO NOTHING would have hidden.
    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership
            SET active_period = daterange(CURRENT_DATE - 2, CURRENT_DATE - 1, '[)')
          WHERE user_id=$1 AND project_id=$2
            AND role_id = (SELECT id FROM role WHERE code='CM' AND owner_org_id IS NULL)`,
        [uid, projectId],
      );
    });

    const after = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT count(*)::int n FROM access_grant WHERE user_id=$1 AND project_id=$2`,
          [uid, projectId],
        )
      ).rows[0].n,
    );
    expect(after, 'the Engineering Manager still holds their own role').toBe(2);
    expect(await countAs(USERS.em, 'zone')).toBeGreaterThan(0);
  });

  it('a user cannot hold roles on both sides of one contract', async () => {
    // side drives the client/contractor UI shell, so collapsing two sides onto
    // one grant would mean nobody knows which side they are signing on.
    const projectId = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    const uid = await userId(USERS.qm); // contractor side

    await expect(
      asOwner(async (c) =>
        c.query(
          `INSERT INTO project_membership (project_id, user_id, role_id, write_scope_type)
           VALUES ($1,$2,(SELECT id FROM role WHERE code='SR' AND owner_org_id IS NULL),'project')`,
          [projectId, uid],
        ),
      ),
    ).rejects.toThrow(/LOTLINE_SIDE_CONFLICT/);
  });
});
