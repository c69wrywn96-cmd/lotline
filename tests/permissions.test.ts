/**
 * Permission resolution (migration 0012, src/auth/permissions.ts).
 *
 * The resolution order from 03-permission-matrix.md §9 is asserted step by step,
 * and each refusal is checked for the RIGHT reason — a rule that denies for the
 * wrong reason is a rule that will allow for the wrong reason later.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb, userId, USERS } from './helpers.js';
import { PermissionResolver, PERMISSIONS, NON_DELEGABLE, PermissionError, type Permission, type Subject } from '../src/auth/permissions.js';
import type { SessionContext } from '../src/db/session.js';

afterAll(async () => { await appDb.end(); });

let cachedProject: string | undefined;
async function project(): Promise<string> {
  cachedProject ??= await asOwner(async (c) => {
    const row = (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0];
    if (!row) throw new Error('seed: project MRU2 missing');
    return row.id as string;
  });
  return cachedProject;
}

/**
 * Models an ordinary logged-in user. Per 03-permission-matrix.md §10 a full IdP
 * session satisfies `device_unlock` — that level means "this human proved who
 * they are on this device", which a desktop SSO login does. Bare `session` is
 * the weaker case: a long-lived session that has not re-unlocked.
 */
async function decide(
  user: string, permission: Permission, subject: Partial<Subject> = {},
  ctx: Partial<SessionContext> = {},
) {
  const uid = await userId(user);
  const projectId = await project();
  return appDb.withSession({ userId: uid, authStrength: 'device_unlock', ...ctx }, async (db) =>
    new PermissionResolver(db).decide(permission, { projectId, ...subject }),
  );
}

describe('the vocabulary cannot drift from the catalogue', () => {
  it('every TypeScript permission exists in the database, and vice versa', async () => {
    const dbCodes = await asOwner(async (c) =>
      (await c.query(`SELECT code FROM permission ORDER BY code`)).rows.map((r) => r.code as string),
    );
    expect([...PERMISSIONS].sort()).toEqual(dbCodes);
  });

  it('the non-delegable list matches what the database refuses to delegate', async () => {
    // Mirrors auth.assert_delegable() in migration 0003.
    const fn = await asOwner(async (c) =>
      (await c.query(`SELECT prosrc FROM pg_proc WHERE proname='assert_delegable'`)).rows[0].prosrc as string,
    );
    for (const code of NON_DELEGABLE) {
      expect(fn, `${code} must be refused by the delegation trigger`).toContain(code);
    }
  });
});

describe('step 4 — scope', () => {
  it('a JV engineer is allowed in their own zone', async () => {
    const d = await decide(USERS.peA, 'lot.raise', { zonePath: 'North.Z3' });
    expect(d).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('and refused in the other partner zone, with the honest reason', async () => {
    const d = await decide(USERS.peA, 'lot.raise', { zonePath: 'South.Z5' });
    // Not "not found": the row is legitimately visible to them (ADR-0020).
    expect(d).toEqual({ allowed: false, reason: 'outside_write_scope' });
  });

  it('a write scope covers the whole WBS subtree beneath it', async () => {
    const uid = await userId(USERS.qm); // project-wide write
    const projectId = await project();
    const d = await appDb.withSession({ userId: uid, authStrength: 'step_up' }, async (db) =>
      new PermissionResolver(db).decide('lot.raise', { projectId, wbsPath: 'w3.w2.w1.w4' }),
    );
    expect(d.allowed).toBe(true);
  });

  it('a subcontractor outside their package gets out_of_scope, which is a 404', async () => {
    const d = await decide(USERS.subEarth, 'checkpoint.action', { zonePath: 'North.Z3' });
    expect(d.reason).toBe('out_of_scope');
    const err = new PermissionError('checkpoint.action', 'out_of_scope');
    expect(err.httpStatus).toBe(404); // absence must not leak existence
  });

  it('a subcontractor inside their own package is allowed', async () => {
    const pkg = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM subcontract_package WHERE package_code='P1-EARTH'`)).rows[0].id,
    );
    const d = await decide(USERS.subEarth, 'checkpoint.action', { packageId: pkg });
    expect(d).toEqual({ allowed: true, reason: 'allowed' });
  });
});

describe('step 5 — permission held', () => {
  it('a cadet cannot raise a lot', async () => {
    const d = await decide(USERS.cadetA, 'lot.raise', { zonePath: 'North.Z3' });
    expect(d).toEqual({ allowed: false, reason: 'permission_not_held' });
  });

  it('a cadet can create and populate one', async () => {
    const d = await decide(USERS.cadetA, 'lot.create', { zonePath: 'North.Z3' });
    expect(d.allowed).toBe(true);
  });

  it('the Independent Verifier holds no write scope at all', async () => {
    const d = await decide(USERS.iv, 'lot.raise', {});
    expect(d.reason).toBe('outside_write_scope');
  });

  it('...but reads the whole project', async () => {
    const d = await decide(USERS.iv, 'lot.view', { kind: 'read' });
    expect(d.allowed).toBe(true);
  });

  it('an unknown permission code fails closed', async () => {
    const d = await decide(USERS.qm, 'lot.definitely_not_real' as Permission, {});
    expect(d).toEqual({ allowed: false, reason: 'unknown_permission' });
  });
});

describe('ADR-0023 — organisation-scoped authority resolves', () => {
  it('the Group QM holds the counter-signature permission with no project membership', async () => {
    const d = await decide(USERS.gqm, 'signature.withdraw.countersign', {},
                           { authStrength: 'step_up' });
    expect(d).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('but holds no project nomination — a group appointment is not a nomination', async () => {
    for (const code of ['checkpoint.hold.release', 'lot.raise', 'checkpoint.sign'] as Permission[]) {
      const d = await decide(USERS.gqm, code, {}, { authStrength: 'step_up' });
      expect(d.reason, code).toBe('permission_not_held');
    }
  });
});

describe('§10 — authentication strength', () => {
  it('releasing a hold point requires step-up; a device unlock is not enough', async () => {
    const weak = await decide(USERS.sr, 'checkpoint.hold.release', {},
                              { authStrength: 'device_unlock' });
    expect(weak).toEqual({ allowed: false, reason: 'step_up_required' });

    const strong = await decide(USERS.sr, 'checkpoint.hold.release', {},
                                { authStrength: 'step_up' });
    expect(strong.allowed).toBe(true);
  });

  it('a retrospective release is held to exactly the same bar', async () => {
    const weak = await decide(USERS.sr, 'checkpoint.hold.release.retrospective', {},
                              { authStrength: 'device_unlock' });
    expect(weak.reason).toBe('step_up_required');
  });

  it('an unset strength defaults to the weakest, never the strongest', async () => {
    // Bypasses the helper's realistic default: this is the raw wrapper contract.
    const uid = await userId(USERS.sr);
    const projectId = await project();
    const d = await appDb.withSession({ userId: uid }, async (db) =>
      new PermissionResolver(db).decide('checkpoint.hold.release', { projectId }),
    );
    expect(d.reason).toBe('step_up_required');
  });

  it('a bare session cannot even sign an ordinary checkpoint', async () => {
    const d = await decide(USERS.foreman, 'checkpoint.sign', { zonePath: 'South.Z5' },
                           { authStrength: 'session' });
    expect(d.reason).toBe('step_up_required');
  });

  it('field work proceeds at ordinary session strength', async () => {
    const d = await decide(USERS.foreman, 'checkpoint.evidence.attach', { zonePath: 'South.Z5' });
    expect(d.allowed).toBe(true);
  });
});

describe('device-bound sessions are capability-restricted regardless of role', () => {
  it('a Quality Manager on a shared tablet cannot manage roles or export', async () => {
    for (const code of ['admin.roles.manage', 'admin.users.manage', 'export.data',
                        'export.audit_log', 'api.key.manage'] as Permission[]) {
      const d = await decide(USERS.qm, code, {},
                             { deviceBound: true, authStrength: 'step_up' });
      expect(d, code).toEqual({ allowed: false, reason: 'not_available_on_shared_device' });
    }
  });

  it('the same Quality Manager holds all of them on their own device', async () => {
    for (const code of ['admin.roles.manage', 'export.data'] as Permission[]) {
      const d = await decide(USERS.qm, code, {}, { authStrength: 'step_up' });
      expect(d.allowed, code).toBe(true);
    }
  });

  it('field work still works on the shared tablet, or the product is unusable', async () => {
    const d = await decide(USERS.cadetA, 'checkpoint.evidence.attach',
                           { zonePath: 'North.Z3' }, { deviceBound: true });
    expect(d.allowed).toBe(true);
  });
});

describe('numeric constraints', () => {
  it('a cost ceiling is read from the role, and two roles take the higher', async () => {
    const projectId = await project();
    await asOwner(async (c) => {
      await c.query(
        `UPDATE role_permission SET constraint_json = '{"max_cost_impact": 50000}'::jsonb
          WHERE permission_code = 'lot.closeout.approve'
            AND role_id = (SELECT id FROM role WHERE code='CM' AND owner_org_id IS NULL)`,
      );
      await c.query(
        `UPDATE role_permission SET constraint_json = '{"max_cost_impact": 250000}'::jsonb
          WHERE permission_code = 'lot.closeout.approve'
            AND role_id = (SELECT id FROM role WHERE code='PD' AND owner_org_id IS NULL)`,
      );
    });

    // Give the QM both CM and PD memberships; holding an extra role must never
    // REDUCE authority, so the ceiling is the higher of the two.
    const uid = await userId(USERS.qm);
    await asOwner(async (c) => {
      for (const code of ['CM', 'PD']) {
        await c.query(
          `INSERT INTO project_membership (project_id, user_id, role_id, write_scope_type)
           VALUES ($1,$2,(SELECT id FROM role WHERE code=$3 AND owner_org_id IS NULL),'project')`,
          [projectId, uid, code],
        );
      }
    });

    const limit = await appDb.withSession({ userId: uid }, async (db) =>
      new PermissionResolver(db).limit('lot.closeout.approve', projectId, 'max_cost_impact'),
    );
    expect(limit).toBe(250000);

    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership SET active_period = daterange(CURRENT_DATE - 2, CURRENT_DATE - 1, '[)')
          WHERE user_id=$1 AND role_id IN (SELECT id FROM role WHERE code IN ('CM','PD') AND owner_org_id IS NULL)`,
        [uid],
      );
    });
  });

  it('an unconfigured ceiling is null, not zero and not infinity', async () => {
    const projectId = await project();
    const uid = await userId(USERS.qm);
    const limit = await appDb.withSession({ userId: uid }, async (db) =>
      new PermissionResolver(db).limit('lot.raise', projectId, 'max_cost_impact'),
    );
    expect(limit).toBeNull();
  });
});

describe('lapsed access', () => {
  it('an expired membership grants nothing, without anything being deleted', async () => {
    const projectId = await project();
    const uid = await userId(USERS.foreman);

    expect((await decide(USERS.foreman, 'checkpoint.action', { zonePath: 'South.Z5' })).allowed).toBe(true);

    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership
            SET active_period = daterange(lower(active_period), CURRENT_DATE, '[)')
          WHERE user_id=$1 AND project_id=$2`,
        [uid, projectId],
      );
    });

    const after = await decide(USERS.foreman, 'checkpoint.action', { zonePath: 'South.Z5' });
    expect(after.reason).toBe('out_of_scope');

    // The membership row still exists — nothing is ever deleted (ADR-0003).
    const still = await asOwner(async (c) =>
      (await c.query(`SELECT count(*)::int n FROM project_membership WHERE user_id=$1`, [uid])).rows[0].n,
    );
    expect(still).toBeGreaterThan(0);

    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership SET active_period = daterange(lower(active_period), NULL, '[)')
          WHERE user_id=$1 AND project_id=$2`,
        [uid, projectId],
      );
    });
  });
});

describe('the RLS write policies use the resolver where it matters', () => {
  it('a section engineer cannot grant themselves a membership', async () => {
    const projectId = await project();
    const uid = await userId(USERS.peA);
    await expect(
      appDb.withSession({ userId: uid, authStrength: 'step_up' }, async (db) =>
        db.query(
          `INSERT INTO project_membership (project_id, user_id, role_id, write_scope_type)
           VALUES ($1,$2,(SELECT id FROM role WHERE code='QM' AND owner_org_id IS NULL),'project')`,
          [projectId, uid],
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('a section engineer cannot enrol a device', async () => {
    const projectId = await project();
    const uid = await userId(USERS.foreman); // FMN holds no admin.device.enrol
    await expect(
      appDb.withSession({ userId: uid, authStrength: 'step_up' }, async (db) =>
        db.query(
          `INSERT INTO device (project_id, label, platform, device_fingerprint)
           VALUES ($1,'rogue','android','fp-rogue')`,
          [projectId],
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});
