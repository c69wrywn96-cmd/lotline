/**
 * Guarding against silent RLS pruning (ADR-0026).
 *
 * The class: a policy predicate, or a SECURITY INVOKER helper used for a
 * cross-user lookup, that reads another RLS-enabled table. Postgres applies that
 * table's own policy inside the predicate, so a question about somebody else can
 * only answer "no rows".
 *
 * It is worse than a denial because there is no denial — 200, empty array, blank
 * screen, nothing in the log. Six instances were found in Phase 1, each only
 * when a screen first needed to render another person's data. This suite exists
 * so the seventh fails the build instead.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb, as, userId, USERS } from './helpers';

afterAll(async () => { await appDb.end(); });

describe('static: every policy reference to an RLS table is declared', () => {
  it('has no undeclared references', async () => {
    const risks = await asOwner(async (c) =>
      (await c.query(
        `SELECT on_table, policy_name, referenced_table FROM audit.rls_reference_risks()
          ORDER BY 1,2,3`)).rows,
    );
    // A new policy that reads another RLS-enabled table must be declared in
    // rls_reference_declaration with a disposition and a reason. If this fails,
    // ask: can this predicate ever need to answer a question about someone
    // else's row? If yes, move the lookup into a SECURITY DEFINER helper.
    expect(risks, `undeclared RLS references:\n${JSON.stringify(risks, null, 2)}`).toEqual([]);
  });

  it('every declaration carries a real reason, enforced by constraint', async () => {
    const thin = await asOwner(async (c) =>
      (await c.query(
        `SELECT on_table, policy_name FROM rls_reference_declaration
          WHERE length(btrim(reason)) < 60`)).rows,
    );
    expect(thin, 'a declaration without a reason is a rubber stamp').toEqual([]);

    // And it is a constraint, not a convention: the next person adding a
    // declaration under time pressure is exactly who a convention fails.
    await expect(
      asOwner(async (c) => c.query(
        `INSERT INTO rls_reference_declaration
           (on_table, policy_name, referenced_table, disposition, reason)
         VALUES ('x','y','z','pruning_intended','same as above')`)),
    ).rejects.toThrow(/reason_is_an_argument/);
  });

  it('the detector uses pg_depend, not a regex over policy text', async () => {
    // A regex over `\mproject\M` flagged contract_update, which does not
    // reference the project table at all. A detector with false positives is one
    // people learn to ignore.
    const def = await asOwner(async (c) =>
      (await c.query(
        `SELECT pg_get_viewdef('audit.rls_policy_references'::regclass) AS d`)).rows[0].d);
    expect(def).toContain('pg_depend');
  });
});

describe('static: policy helpers cannot inherit the caller RLS', () => {
  it('every helper used in a policy is SECURITY DEFINER with a pinned search_path', async () => {
    const risks = await asOwner(async (c) =>
      (await c.query(`SELECT function_name, problem FROM audit.policy_helper_risks()`)).rows,
    );
    expect(risks, `unsafe policy helpers:\n${JSON.stringify(risks, null, 2)}`).toEqual([]);
  });

  it('auth.in_scope does not depend on access_grant policy', async () => {
    // If it did, tightening that one policy would make every table in the
    // database read as empty.
    const fn = await asOwner(async (c) =>
      (await c.query(
        `SELECT prosecdef, proconfig::text FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='auth' AND p.proname='in_scope'`)).rows[0]);
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toContain('search_path');
  });
});

describe('runtime: cross-user questions actually answer', () => {
  /**
   * The empirical half. Each of these would have returned an empty result under
   * one of the six defects, and each is asked AS AN APPLICATION USER rather than
   * as the owner — which is how the seventh instance hid from its own test.
   */
  it('a Quality Manager can see another person', async () => {
    const rows = await as<{ full_name: string }>(
      USERS.qm, `SELECT full_name FROM user_account WHERE email = $1`, [USERS.peA]);
    expect(rows.map((r) => r.full_name)).toEqual(['Jarrah Okafor']);
  });

  it('a Quality Manager can see another person scopes', async () => {
    const target = await userId(USERS.peA);
    const rows = await as<{ grant_kind: string; scope_type: string }>(
      USERS.qm,
      `SELECT grant_kind, scope_type FROM access_grant WHERE user_id = $1 ORDER BY grant_kind`,
      [target]);
    expect(rows).toEqual([
      { grant_kind: 'read', scope_type: 'project' },
      { grant_kind: 'write', scope_type: 'zone' },
    ]);
  });

  it('a supervisor can see who is enrolled on a shared device', async () => {
    const rows = await as<{ n: string }>(
      USERS.qm,
      `SELECT count(*)::text n
         FROM device_user_enrolment due
         JOIN device d ON d.id = due.device_id
        WHERE d.device_fingerprint = 'fp-z3-tablet-02' AND due.revoked_at IS NULL`);
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('a supervisor can see the authentication behind another person enrolment', async () => {
    const rows = await as<{ n: string }>(
      USERS.qm,
      `SELECT count(*)::text n
         FROM device_user_enrolment due
         JOIN device d ON d.id = due.device_id
         JOIN authentication_event e ON e.id = due.enrolment_auth_event_id
        WHERE d.device_fingerprint = 'fp-z3-tablet-02'`);
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('the OQ-19 unstick valve answers as an application user, not just as owner', async () => {
    // The seventh instance. It was SECURITY INVOKER, so for an app-role caller
    // it returned NO eligible counter-signatories — reporting "nobody can
    // counter-sign this" when somebody could. Its original test passed because
    // it ran as the owner.
    const project = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    const qm = await userId(USERS.qm);

    const eligible = await as<{ user_id: string; via: string }>(
      USERS.qm,
      `SELECT user_id, via FROM auth.eligible_withdrawal_countersignatories($1,$2)`,
      [project, qm]);

    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.map((e) => e.user_id)).not.toContain(qm);
    expect(eligible.some((e) => e.via === 'organisation')).toBe(true);
  });

  it('a subcontractor still cannot see another subcontractor — the fence holds', async () => {
    const rows = await as<{ full_name: string }>(
      USERS.subEarth, `SELECT full_name FROM user_account WHERE email = $1`, [USERS.subDrain]);
    expect(rows).toEqual([]);
  });

  it('a subcontractor cannot see a competitor organisation', async () => {
    const rows = await as<{ legal_name: string }>(
      USERS.subEarth,
      `SELECT legal_name FROM organisation WHERE legal_name = 'Rowe Drainage Pty Ltd'`);
    expect(rows).toEqual([]);
  });

  it('...but can see the head contractor they work for', async () => {
    const rows = await as<{ legal_name: string }>(
      USERS.subEarth,
      `SELECT legal_name FROM organisation WHERE legal_name = 'Northbound Civil Pty Ltd'`);
    expect(rows.length).toBe(1);
  });
});
