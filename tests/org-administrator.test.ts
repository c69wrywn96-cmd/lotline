/**
 * Organisation Administrator (migration 0025) — the counter-signatory of last
 * resort.
 *
 * "Nobody can grant themselves a role" is right and creates a deadlock. This is
 * the structural exit. The tests below exist to keep it an exit and stop it
 * becoming a superuser.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb, as, userId, USERS } from './helpers';

afterAll(async () => { await appDb.end(); });

const ORG_ADMIN_1 = 'l.mwangi@northboundcivil.com.au';
const ORG_ADMIN_2 = 'f.szabo@northboundcivil.com.au';

const project = () => asOwner(async (c) =>
  (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id as string);
const northbound = () => asOwner(async (c) =>
  (await c.query(`SELECT id FROM organisation WHERE legal_name='Northbound Civil Pty Ltd'`))
    .rows[0].id as string);

describe('authority to unstick people, not to do the work', () => {
  it('no organisation-scoped role holds a permission that DOES the work', async () => {
    const risks = await asOwner(async (c) =>
      (await c.query(`SELECT role_code, permission_code FROM audit.org_role_privilege_risks()`)).rows);
    expect(risks, `organisation roles overreaching:\n${JSON.stringify(risks, null, 2)}`).toEqual([]);
  });

  it('an organisation administrator cannot sign, release or certify', async () => {
    const p = await project();
    for (const code of ['checkpoint.sign', 'checkpoint.hold.release',
                        'lot.certify_conformance', 'lot.accept', 'lot.raise'] as const) {
      const rows = await as<{ ok: boolean }>(
        ORG_ADMIN_1, `SELECT auth.can($1,$2,'write') AS ok`, [code, p]);
      expect(rows[0]?.ok, code).toBe(false);
    }
  });

  it('but can counter-sign and administer', async () => {
    const p = await project();
    for (const code of ['signature.withdraw.countersign', 'admin.role_grant.countersign',
                        'admin.users.manage'] as const) {
      const rows = await as<{ ok: boolean }>(
        ORG_ADMIN_1, `SELECT auth.has_permission($1,$2) AS ok`, [code, p]);
      expect(rows[0]?.ok, code).toBe(true);
    }
  });

  it('its authority reaches every project the organisation participates in, with no membership', async () => {
    const memberships = await asOwner(async (c) =>
      (await c.query(
        `SELECT count(*)::int n FROM project_membership pm
           JOIN user_account u ON u.id = pm.user_id WHERE u.email = $1`, [ORG_ADMIN_1])).rows[0].n);
    expect(memberships).toBe(0);

    const zones = await as<{ n: string }>(ORG_ADMIN_1, `SELECT count(*)::text n FROM zone`);
    expect(Number(zones[0]!.n)).toBeGreaterThan(0);
  });
});

describe('at least two, and the last cannot be removed', () => {
  it('the seeded tenant is compliant', async () => {
    const row = await asOwner(async (c) =>
      (await c.query(
        `SELECT administrator_count, compliant FROM audit.org_admin_compliance
          WHERE legal_name = 'Northbound Civil Pty Ltd'`)).rows[0]);
    expect(row.administrator_count).toBe(2);
    expect(row.compliant).toBe(true);
  });

  it('removing one administrator is refused while it would leave fewer than two', async () => {
    const org = await northbound();
    await expect(
      asOwner(async (c) => c.query(
        `UPDATE org_membership
            SET active_period = daterange(lower(active_period), CURRENT_DATE, '[)')
          WHERE organisation_id = $1
            AND user_id = (SELECT id FROM user_account WHERE email = $2)
            AND role_id = (SELECT id FROM role WHERE code='ORGADMIN' AND owner_org_id IS NULL)`,
        [org, ORG_ADMIN_1])),
    ).rejects.toThrow(/LOTLINE_ORG_ADMIN_FLOOR/);
  });

  it('deleting one is refused for the same reason', async () => {
    const org = await northbound();
    await expect(
      asOwner(async (c) => c.query(
        `DELETE FROM org_membership
          WHERE organisation_id = $1
            AND user_id = (SELECT id FROM user_account WHERE email = $2)
            AND role_id = (SELECT id FROM role WHERE code='ORGADMIN' AND owner_org_id IS NULL)`,
        [org, ORG_ADMIN_2])),
    ).rejects.toThrow(/LOTLINE_ORG_ADMIN_FLOOR/);
  });

  it('appointing a replacement first makes the removal possible', async () => {
    const org = await northbound();
    const third = await asOwner(async (c) => {
      const uid = (await c.query(
        `INSERT INTO user_account (email, full_name, status, primary_org_id, auth_pattern)
         VALUES ('t.aldridge@northboundcivil.com.au','Tamsin Aldridge','active',$1,'home_tenant')
         RETURNING id`, [org])).rows[0].id;
      await c.query(
        `INSERT INTO org_membership (organisation_id, user_id, role_id, job_title)
         VALUES ($1,$2,(SELECT id FROM role WHERE code='ORGADMIN' AND owner_org_id IS NULL),
                 'Organisation Administrator')`, [org, uid]);
      return uid;
    });
    expect(third).toBeTruthy();

    // Now three, so standing one down leaves two.
    await asOwner(async (c) => {
      await c.query(
        `UPDATE org_membership
            SET active_period = daterange(lower(active_period), CURRENT_DATE, '[)')
          WHERE organisation_id = $1
            AND user_id = (SELECT id FROM user_account WHERE email = $2)
            AND role_id = (SELECT id FROM role WHERE code='ORGADMIN' AND owner_org_id IS NULL)`,
        [org, ORG_ADMIN_1]);
    });

    const count = await asOwner(async (c) =>
      (await c.query(`SELECT auth.count_org_administrators($1) AS n`, [org])).rows[0].n);
    expect(count).toBe(2);

    // restore
    await asOwner(async (c) => {
      await c.query(
        `UPDATE org_membership SET active_period = daterange(lower(active_period), NULL, '[)')
          WHERE organisation_id = $1
            AND user_id = (SELECT id FROM user_account WHERE email = $2)`, [org, ORG_ADMIN_1]);
      await c.query(
        `UPDATE org_membership SET active_period = daterange(lower(active_period), CURRENT_DATE, '[)')
          WHERE organisation_id = $1 AND user_id = $2`, [org, third]);
    });
  });
});

describe('the escalation route is logged distinctly from an ordinary counter-signature', () => {
  it('refuses when a project-level route exists — the exit is not the ordinary door', async () => {
    const p = await project();
    const someone = await userId(USERS.peA);
    await expect(
      as(ORG_ADMIN_1,
         `SELECT auth.record_escalation($1,'role_grant_countersign','project_membership',
                                        NULL,'test',$2)`, [p, someone]),
    ).rejects.toThrow(/LOTLINE_PROJECT_ROUTE_AVAILABLE/);
  });

  it('records the escalation when no project route exists, with why', async () => {
    const p = await project();
    // Exclude every project administrator, so no project-level route remains.
    const onlyAdmin = await userId(USERS.qm);
    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership SET active_period = daterange(lower(active_period), CURRENT_DATE, '[)')
          WHERE project_id = $1
            AND role_id IN (SELECT id FROM role WHERE code IN ('EM','CM') AND owner_org_id IS NULL)`,
        [p]);
    });

    const id = await as<{ record_escalation: string }>(
      ORG_ADMIN_1,
      `SELECT auth.record_escalation($1,'role_grant_countersign','project_membership',
                                     NULL,'only project administrator is the subject',$2)
         AS record_escalation`,
      [p, onlyAdmin]);
    expect(id[0]?.record_escalation).toBeTruthy();

    const event = await asOwner(async (c) =>
      (await c.query(
        `SELECT kind, via_role_code, reason, no_project_route_reason
           FROM escalation_event ORDER BY occurred_at DESC LIMIT 1`)).rows[0]);
    expect(event.kind).toBe('role_grant_countersign');
    expect(event.via_role_code).toBe('ORGADMIN');
    expect(event.no_project_route_reason).toContain('no eligible project-level');

    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership SET active_period = daterange(lower(active_period), NULL, '[)')
          WHERE project_id = $1
            AND role_id IN (SELECT id FROM role WHERE code IN ('EM','CM') AND owner_org_id IS NULL)`,
        [p]);
    });
  });

  it('the frequency view shows a Quality Manager how often this is happening', async () => {
    // Weekly use means the project's role structure is wrong, and the QM should
    // be able to see that without reading the audit log line by line.
    const rows = await asOwner(async (c) =>
      (await c.query(
        `SELECT kind, last_30_days FROM audit.escalation_frequency
          WHERE project_id IS NOT NULL`)).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0]!.last_30_days)).toBeGreaterThan(0);
  });

  it('an escalation event cannot be edited or deleted afterwards', async () => {
    for (const stmt of ['UPDATE escalation_event SET reason = $$x$$',
                        'DELETE FROM escalation_event']) {
      await expect(as(USERS.qm, stmt)).rejects.toThrow(/permission denied/i);
    }
  });
});

describe('the counter-signatory resolvers include the organisation route', () => {
  it('a role-grant counter-signatory exists via the organisation', async () => {
    const p = await project();
    const qm = await userId(USERS.qm);
    const rows = await as<{ via: string }>(
      ORG_ADMIN_1,
      `SELECT via FROM auth.eligible_role_grant_countersignatories($1,$2)`, [p, qm]);
    expect(rows.some((r) => r.via === 'organisation')).toBe(true);
  });

  it('and a withdrawal counter-signatory does too', async () => {
    const p = await project();
    const qm = await userId(USERS.qm);
    const rows = await as<{ user_id: string; via: string }>(
      USERS.qm,
      `SELECT user_id, via FROM auth.eligible_withdrawal_countersignatories($1,$2)`, [p, qm]);
    expect(rows.some((r) => r.via === 'organisation')).toBe(true);
    expect(rows.map((r) => r.user_id)).not.toContain(qm);
  });
});
