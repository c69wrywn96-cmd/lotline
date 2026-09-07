/**
 * User and role management (src/app/people/data.ts).
 *
 * Mostly a solved shape. The parts worth testing are the ones that are not:
 * that changing someone's authority requires step-up, that nobody can widen
 * their own, and that the change history comes from the audit log rather than a
 * parallel table that could drift.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb, userId, USERS } from './helpers';
import {
  listPeople, listRoles, grantMembership, endMembership, listMembershipChanges,
  PeopleActionError,
} from '../src/app/people/data';
import { recordAuthenticationEvent, buildSessionContext } from '../src/auth/session-bridge';
import { PermissionError } from '../src/auth/permissions';
import type { SessionContext } from '../src/db/session';
import { randomUUID } from 'node:crypto';

afterAll(async () => { await appDb.end(); });

const projectId = () => asOwner(async (c) =>
  (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id as string);

async function session(email: string, strength: 'device_unlock' | 'step_up' = 'step_up'): Promise<SessionContext> {
  const uid = await userId(email);
  return asOwner(async (c) => {
    const ev = await recordAuthenticationEvent(c, {
      userId: uid,
      method: strength === 'step_up' ? 'idp_reauth' : 'device_pin',
      mfaSatisfied: true,
    });
    return buildSessionContext(c, { userId: uid, authEventId: ev, requestId: randomUUID() });
  });
}

const run = <T>(ctx: SessionContext, fn: (db: any) => Promise<T>) => appDb.withSession(ctx, fn);

const roleId = (code: string) => asOwner(async (c) =>
  (await c.query(`SELECT id FROM role WHERE code=$1 AND owner_org_id IS NULL`, [code]))
    .rows[0].id as string);

describe('the people list', () => {
  it('shows everyone on the project with their roles and scopes', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const people = await run(ctx, (db) => listPeople(db, p));

    const engineer = people.find((p) => p.email === USERS.peA);
    expect(engineer).toBeDefined();
    expect(engineer!.roles.map((r) => r.code)).toContain('PE');
    // The JV shape, rendered: reads the project, writes a zone.
    expect(engineer!.readScope).toBe('project');
    expect(engineer!.writeScope).toBe('zone');
    expect(engineer!.side).toBe('contractor');
  });

  it('shows an organisation-scoped role and says where it comes from', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const people = await run(ctx, (db) => listPeople(db, p));
    const groupQm = people.find((p) => p.email === USERS.gqm);
    expect(groupQm).toBeDefined();
    // A Group QM has no project_membership at all; the screen must not present
    // them as if someone had added them to this project.
    expect(groupQm!.roles).toEqual([
      { code: 'GQM', name: 'Group Quality Manager', scopeLevel: 'organisation', via: 'organisation' },
    ]);
  });

  it('is scoped: a subcontractor does not get a project directory', async () => {
    const ctx = await session(USERS.subEarth);
    const p = await projectId();
    const people = await run(ctx, (db) => listPeople(db, p));
    // They see the delivery team they work with, never a competitor's people.
    expect(people.map((p) => p.email)).not.toContain(USERS.subDrain);
    expect(people.map((p) => p.email)).toContain(USERS.subEarth);
  });
});

describe('the role list surfaces what a role can actually do', () => {
  it('counts permissions and how many demand step-up', async () => {
    const ctx = await session(USERS.qm);
    const roles = await run(ctx, (db) => listRoles(db));

    const sr = roles.find((r) => r.code === 'SR')!;
    expect(sr.side).toBe('client');
    expect(sr.permissionCount).toBeGreaterThan(0);
    // Hold point release, lot acceptance and concession approval are all
    // step-up, so the count must be non-zero — the screen shows it so a
    // configurator can see the weight of a role before granting it.
    expect(sr.stepUpCount).toBeGreaterThan(0);

    const sub = roles.find((r) => r.code === 'SUB')!;
    expect(sub.side).toBe('external');
    expect(sub.grantsProjectWideRead).toBe(false);
  });

  it('shows the organisation-scoped role as such', async () => {
    const ctx = await session(USERS.qm);
    const roles = await run(ctx, (db) => listRoles(db));
    expect(roles.find((r) => r.code === 'GQM')!.scopeLevel).toBe('organisation');
  });
});

describe('granting a membership', () => {
  it('requires the admin permission', async () => {
    const ctx = await session(USERS.peA);
    const p = await projectId();
    await expect(
      run(ctx, async (db) => grantMembership(db, ctx, {
        projectId: p, userId: await userId(USERS.foreman), roleId: await roleId('SE'),
      })),
    ).rejects.toThrow(PermissionError);
  });

  it('requires step-up, not merely a signed-in session', async () => {
    const ctx = await session(USERS.qm, 'device_unlock');
    const p = await projectId();
    const err = await run(ctx, async (db) => grantMembership(db, ctx, {
      projectId: p, userId: await userId(USERS.foreman), roleId: await roleId('SE'),
    }).catch((e) => e));
    expect(err).toBeInstanceOf(PermissionError);
    expect((err as PermissionError).reason).toBe('step_up_required');
  });

  it('NOBODY can grant themselves a role, however administrative', async () => {
    // The single most valuable move with a compromised admin session, and the
    // hardest to spot in a log full of legitimate membership changes.
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const err = await run(ctx, async (db) => grantMembership(db, ctx, {
      projectId: p, userId: ctx.userId, roleId: await roleId('PD'),
    }).catch((e) => e));
    expect(err).toBeInstanceOf(PeopleActionError);
    expect((err as PeopleActionError).code).toBe('no_self_grant');
    expect((err as Error).message).toMatch(/two accounts/);
  });

  it('grants to someone else, and the projection follows immediately', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const surveyorId = await asOwner(async (c) => {
      const org = (await c.query(
        `SELECT id FROM organisation WHERE legal_name='Northbound Civil Pty Ltd'`)).rows[0].id;
      return (await c.query(
        `INSERT INTO user_account (email, full_name, status, primary_org_id, auth_pattern)
         VALUES ('n.abergel@northboundcivil.com.au','Noa Abergel','active',$1,'home_tenant')
         RETURNING id`, [org])).rows[0].id as string;
    });

    await run(ctx, async (db) => grantMembership(db, ctx, {
      projectId: p, userId: surveyorId, roleId: await roleId('SUR'),
      readScopeType: 'project', writeScopeType: 'project',
    }));

    const grants = await asOwner(async (c) =>
      (await c.query(
        `SELECT grant_kind, scope_type FROM access_grant
          WHERE user_id=$1 AND project_id=$2 ORDER BY grant_kind`,
        [surveyorId, p])).rows);
    expect(grants).toEqual([
      { grant_kind: 'read', scope_type: 'project' },
      { grant_kind: 'write', scope_type: 'project' },
    ]);
  });
});

describe('ending a membership', () => {
  it('cannot be done to yourself', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const own = await asOwner(async (c) =>
      (await c.query(
        `SELECT id FROM project_membership WHERE user_id=$1 AND project_id=$2 LIMIT 1`,
        [ctx.userId, p])).rows[0].id);
    const err = await run(ctx, (db) => endMembership(db, ctx, own, p).catch((e) => e));
    expect((err as PeopleActionError).code).toBe('no_self_revoke');
  });

  it('lapses access without deleting anything', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const foreman = await userId(USERS.foreman);
    const membership = await asOwner(async (c) =>
      (await c.query(
        `SELECT id FROM project_membership WHERE user_id=$1 AND project_id=$2
          AND active_period @> CURRENT_DATE LIMIT 1`, [foreman, p])).rows[0].id);

    await run(ctx, (db) => endMembership(db, ctx, membership, p, 'demobilised'));

    const after = await asOwner(async (c) => ({
      grants: (await c.query(
        `SELECT count(*)::int n FROM access_grant WHERE user_id=$1 AND project_id=$2`,
        [foreman, p])).rows[0].n,
      row: (await c.query(
        `SELECT ended_at, ended_by, active_period::text AS period
           FROM project_membership WHERE id=$1`,
        [membership])).rows[0],
    }));
    expect(after.grants, 'access lapses').toBe(0);
    // A membership granted and ended the same day collapses active_period to an
    // empty range, so the ending is recorded explicitly (migration 0021)
    // rather than inferred from a null upper bound.
    expect(after.row.ended_at, 'the ending is recorded').not.toBeNull();
    expect(after.row.ended_by).toBeTruthy();

    await asOwner(async (c) => {
      await c.query(
        `UPDATE project_membership SET active_period = daterange(lower(active_period), NULL, '[)')
          WHERE id=$1`, [membership]);
    });
  });
});

describe('the change history comes from the audit log', () => {
  it('shows who changed whose authority, with before and after values', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const changes = await run(ctx, (db) => listMembershipChanges(db, p, 100));

    expect(changes.length).toBeGreaterThan(0);
    const grant = changes.find((c) => c.action === 'insert' && c.after?.role_id);
    expect(grant).toBeDefined();
    expect(grant!.actorName).toBeTruthy();

    const update = changes.find((c) => c.action === 'update');
    if (update) {
      // Both sides, so an auditor can see what the authority WAS.
      expect(update.before).not.toBeNull();
      expect(update.after).not.toBeNull();
    }
  });

  it('a subcontractor sees no membership history for the project', async () => {
    const ctx = await session(USERS.subEarth);
    const p = await projectId();
    const changes = await run(ctx, (db) => listMembershipChanges(db, p, 100));
    expect(changes).toEqual([]);
  });
});
