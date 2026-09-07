/**
 * Account linking (migration 0014).
 *
 * The runtime non-reroute rule is correct, but without a deliberate migration
 * path it is a one-way door: an acquired subcontractor's people would be stuck
 * on PINs and TOTP forever. These tests assert the door opens exactly one way —
 * three-party, explicit, audited — and never on its own.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb, userId, USERS } from './helpers';
import { resolveRealm } from '../src/auth/home-realm';
import { loadRealmRoutes, loadKnownPattern } from '../src/auth/realm-lookup';
import pg from 'pg';

afterAll(async () => { await appDb.end(); });

/**
 * A dedicated user for the destructive end-to-end migration.
 *
 * Deliberately NOT one of the seeded subcontractors: completing a link mutates
 * auth_pattern, and other suites assert that the seeded subcontractor is still
 * on local credentials. A test that quietly rewrites shared fixture state makes
 * the next failure someone else's problem.
 */
const MIGRANT = 'j.castellano@vellacott.com.au';

async function ensureMigrant(): Promise<string> {
  return asOwner(async (c) => {
    const found = await c.query(`SELECT id FROM user_account WHERE email=$1`, [MIGRANT]);
    if (found.rowCount) return found.rows[0].id;
    const org = (await c.query(
      `SELECT id FROM organisation WHERE legal_name='Vellacott Earthmoving Pty Ltd'`)).rows[0].id;
    const pkg = (await c.query(
      `SELECT id FROM subcontract_package WHERE package_code='P1-EARTH'`)).rows[0].id;
    const proj = (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id;
    const uid = (await c.query(
      `INSERT INTO user_account (email, full_name, status, primary_org_id, auth_pattern)
       VALUES ($1,'Joana Castellano','active',$2,'local_credentials') RETURNING id`,
      [MIGRANT, org])).rows[0].id;
    await c.query(
      `INSERT INTO project_membership (project_id, user_id, role_id,
                                       read_scope_type, read_scope_id,
                                       write_scope_type, write_scope_id)
       VALUES ($1,$2,(SELECT id FROM role WHERE code='SUB' AND owner_org_id IS NULL),
               'package',$3,'package',$3)`, [proj, uid, pkg]);
    return uid;
  });
}

/** Runs as the app role with a bound identity, so permission guards apply. */
async function asUser<T>(email: string, fn: (db: { query: any }) => Promise<T>,
                         strength: 'session' | 'device_unlock' | 'step_up' = 'step_up'): Promise<T> {
  const uid = await userId(email);
  return appDb.withSession({ userId: uid, authStrength: strength }, fn as any);
}

async function initiate(admin: string, subject: string, idpDomain: string,
                        strength: 'session' | 'device_unlock' | 'step_up' = 'step_up') {
  const subjectId = await userId(subject);
  const idp = await asOwner(async (c) =>
    (await c.query(
      `SELECT id FROM org_identity_provider WHERE $1 = ANY(allowed_email_domains)`,
      [idpDomain])).rows[0].id);
  return asUser(admin, async (db) => {
    const r = await db.query(
      `SELECT * FROM auth.initiate_identity_link($1,'federated_oidc',$2)`,
      [subjectId, idp]);
    return r.rows[0] as { request_id: string; verification_token: string };
  }, strength);
}

/** A federated provider that claims the subcontractor's domain. */
async function ensureAcquirerIdp(): Promise<string> {
  return asOwner(async (c) => {
    const existing = await c.query(
      `SELECT id FROM org_identity_provider WHERE 'vellacott.com.au' = ANY(allowed_email_domains)`);
    if (existing.rowCount) return existing.rows[0].id;
    const org = (await c.query(
      `SELECT id FROM organisation WHERE legal_name = 'Vellacott Earthmoving Pty Ltd'`)).rows[0].id;
    return (await c.query(
      `INSERT INTO org_identity_provider (organisation_id, protocol, issuer, client_id,
                                          allowed_email_domains, status)
       VALUES ($1,'oidc','https://login.acquirer.example/','lotline',
               ARRAY['vellacott.com.au'],'active') RETURNING id`, [org])).rows[0].id;
  });
}

describe('the door does not open on its own', () => {
  it('registering an IdP for a local user domain does NOT re-route them', async () => {
    await ensureAcquirerIdp();

    // The domain is now claimed by an active provider...
    const routes = await asOwner(loadRealmRoutes);
    expect(routes.map((r) => r.domain)).toContain('vellacott.com.au');

    // ...and the user is still on local credentials, because nothing observes
    // org_identity_provider and re-points anyone at it.
    const pattern = await asOwner((c) => loadKnownPattern(c, USERS.subEarth));
    expect(pattern).toBe('local_credentials');
    expect(resolveRealm(USERS.subEarth, { routes, homeTenantDomains: [], knownPattern: pattern }))
      .toEqual({ kind: 'local_credentials' });
  });

  it('there is no trigger on org_identity_provider that could do it', async () => {
    const triggers = await asOwner(async (c) =>
      (await c.query(
        `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'org_identity_provider' AND NOT t.tgisinternal`)).rows,
    );
    // Only the domain-disjointness guard and the audit trigger. Nothing that
    // touches user_account or auth_identity.
    expect(triggers.map((t) => t.tgname).sort()).toEqual(['org_idp_domains_disjoint', 'zzz_audit']);
  });
});

describe('initiation is administrative and requires step-up', () => {
  it('an ordinary engineer cannot initiate a link', async () => {
    const subject = await userId(USERS.subEarth);
    const idp = await ensureAcquirerIdp();
    await expect(
      asUser(USERS.peA, async (db) =>
        db.query(`SELECT * FROM auth.initiate_identity_link($1,'federated_oidc',$2)`, [subject, idp])),
    ).rejects.toThrow(/LOTLINE_LINK_NOT_AUTHORISED/);
  });

  it('even an authorised admin needs step-up — this changes how someone signs in', async () => {
    const subject = await userId(USERS.subEarth);
    const idp = await ensureAcquirerIdp();
    await expect(
      asUser(USERS.qm, async (db) =>
        db.query(`SELECT * FROM auth.initiate_identity_link($1,'federated_oidc',$2)`, [subject, idp]),
        'device_unlock'),
    ).rejects.toThrow(/LOTLINE_LINK_STEP_UP_REQUIRED/);
  });

  it('a link to a suspended provider is refused', async () => {
    const subject = await userId(USERS.subEarth);
    const idp = await ensureAcquirerIdp();
    await asOwner(async (c) => {
      await c.query(`UPDATE org_identity_provider SET status='suspended' WHERE id=$1`, [idp]);
    });
    await expect(
      asUser(USERS.qm, async (db) =>
        db.query(`SELECT * FROM auth.initiate_identity_link($1,'federated_oidc',$2)`, [subject, idp])),
    ).rejects.toThrow(/LOTLINE_LINK_IDP_NOT_ACTIVE/);
    await asOwner(async (c) => {
      await c.query(`UPDATE org_identity_provider SET status='active' WHERE id=$1`, [idp]);
    });
  });
});

describe('the admin cannot complete what they initiated', () => {
  it('completion is refused until the user has verified from the target provider', async () => {
    await ensureAcquirerIdp();
    const { request_id } = await initiate(USERS.qm, USERS.subEarth, 'vellacott.com.au');
    await expect(
      asUser(USERS.qm, async (db) =>
        db.query(`SELECT auth.complete_identity_link($1)`, [request_id])),
    ).rejects.toThrow(/LOTLINE_LINK_NOT_VERIFIED/);
    await asOwner(async (c) => {
      await c.query(`SELECT auth.cancel_identity_link($1,'test cleanup')`, [request_id]);
    });
  });

  it('verification requires the token the admin never sees again after issue', async () => {
    const { request_id } = await initiate(USERS.qm, USERS.subEarth, 'vellacott.com.au');
    await expect(
      asOwner(async (c) =>
        c.query(`SELECT auth.verify_identity_link($1,$2,$3,$4)`,
                [request_id, 'not-the-token', 'sub-1', USERS.subEarth])),
    ).rejects.toThrow(/LOTLINE_LINK_BAD_TOKEN/);
    await asOwner(async (c) => {
      await c.query(`SELECT auth.cancel_identity_link($1,'test cleanup')`, [request_id]);
    });
  });

  it('only the hash of the token is stored', async () => {
    const { request_id, verification_token } = await initiate(USERS.qm, USERS.subEarth, 'vellacott.com.au');
    const row = await asOwner(async (c) =>
      (await c.query(`SELECT verification_hash FROM identity_link_request WHERE id=$1`,
                     [request_id])).rows[0]);
    expect(row.verification_hash).not.toBe(verification_token);
    expect(row.verification_hash).toMatch(/^[0-9a-f]{64}$/);
    await asOwner(async (c) => {
      await c.query(`SELECT auth.cancel_identity_link($1,'test cleanup')`, [request_id]);
    });
  });
});

describe('verification binds the same person, not merely a valid login', () => {
  it('a federated account with a different address is refused', async () => {
    const { request_id, verification_token } = await initiate(USERS.qm, USERS.subEarth, 'vellacott.com.au');
    await expect(
      asOwner(async (c) =>
        c.query(`SELECT auth.verify_identity_link($1,$2,$3,$4)`,
                [request_id, verification_token, 'sub-x', 'someone.else@vellacott.com.au'])),
    ).rejects.toThrow(/LOTLINE_LINK_EMAIL_MISMATCH/);
    await asOwner(async (c) => {
      await c.query(`SELECT auth.cancel_identity_link($1,'test cleanup')`, [request_id]);
    });
  });

  it('a federated subject already belonging to someone else is refused', async () => {
    // Otherwise one federated identity could absorb a second local account.
    const other = await userId(USERS.subDrain);
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO auth_identity (user_id, provider, subject) VALUES ($1,'local','taken-subject')`,
        [other]);
    });
    const { request_id, verification_token } = await initiate(USERS.qm, USERS.subEarth, 'vellacott.com.au');
    await expect(
      asOwner(async (c) =>
        c.query(`SELECT auth.verify_identity_link($1,$2,$3,$4)`,
                [request_id, verification_token, 'taken-subject', USERS.subEarth])),
    ).rejects.toThrow(/LOTLINE_LINK_SUBJECT_TAKEN/);
    await asOwner(async (c) => {
      await c.query(`SELECT auth.cancel_identity_link($1,'test cleanup')`, [request_id]);
      await c.query(`UPDATE auth_identity SET revoked_at = now() WHERE subject='taken-subject'`);
    });
  });
});

describe('the full migration retires without deleting', () => {
  it('links a local subcontractor to their acquirer IdP end to end', async () => {
    const uid = await ensureMigrant();
    const idp = await ensureAcquirerIdp();

    // Give them the local credential estate a real subcontractor would have.
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO auth_credential (user_id, password_hash) VALUES ($1,'$argon2id$seeded')
         ON CONFLICT (user_id) DO UPDATE SET retired_at = NULL, retire_reason = NULL`, [uid]);
      await c.query(
        `INSERT INTO auth_totp (user_id, secret_encrypted, confirmed_at)
         VALUES ($1, '\\x00'::bytea, now()) ON CONFLICT DO NOTHING`, [uid]);
      await c.query(
        `INSERT INTO auth_identity (user_id, provider, subject) VALUES ($1,'local',$2)
         ON CONFLICT DO NOTHING`, [uid, `local:${uid}`]);
    });

    const { request_id, verification_token } = await initiate(USERS.qm, MIGRANT, 'vellacott.com.au');

    await asOwner(async (c) => {
      await c.query(`SELECT auth.verify_identity_link($1,$2,$3,$4,$5)`,
                    [request_id, verification_token, 'acquirer|joana',
                     MIGRANT, 'https://login.acquirer.example/']);
      await c.query(`SELECT auth.complete_identity_link($1)`, [request_id]);
    });

    const after = await asOwner(async (c) => ({
      user: (await c.query(`SELECT auth_pattern FROM user_account WHERE id=$1`, [uid])).rows[0],
      identities: (await c.query(
        `SELECT provider, subject, revoked_at IS NOT NULL AS revoked
           FROM auth_identity WHERE user_id=$1 ORDER BY provider`, [uid])).rows,
      credential: (await c.query(
        `SELECT retired_at IS NOT NULL AS retired, retire_reason
           FROM auth_credential WHERE user_id=$1`, [uid])).rows[0],
      totp: (await c.query(
        `SELECT count(*)::int n FROM auth_totp WHERE user_id=$1 AND revoked_at IS NULL`,
        [uid])).rows[0],
      request: (await c.query(
        `SELECT status FROM identity_link_request WHERE id=$1`, [request_id])).rows[0],
    }));

    expect(after.request.status).toBe('completed');
    expect(after.user.auth_pattern).toBe('federated_oidc');

    // Both identities remain attached to the ONE user record.
    const federated = after.identities.find((i) => i.provider === 'oidc_federated');
    const local = after.identities.find((i) => i.provider === 'local');
    expect(federated).toBeDefined();
    expect(federated.revoked).toBe(false);
    expect(local, 'the local identity is retained, not deleted').toBeDefined();
    expect(local.revoked, 'but can no longer authenticate').toBe(true);

    // The credential is retired with a reason, never deleted (ADR-0003).
    expect(after.credential.retired).toBe(true);
    expect(after.credential.retire_reason).toContain('migrated to federated_oidc');
    expect(after.totp.n, 'TOTP enrolment is revoked with the credential').toBe(0);

    // ...and now home-realm discovery routes them to the IdP, because their
    // stored pattern changed — not because the domain did.
    const routes = await asOwner(loadRealmRoutes);
    const pattern = await asOwner((c) => loadKnownPattern(c, MIGRANT));
    expect(resolveRealm(MIGRANT, { routes, homeTenantDomains: [], knownPattern: pattern }).kind)
      .toBe('federated');

    // The seeded subcontractor is untouched: nothing about registering an IdP or
    // migrating a colleague moves anyone else.
    const bystander = await asOwner((c) => loadKnownPattern(c, USERS.subEarth));
    expect(bystander).toBe('local_credentials');
  });

  it('the whole migration is in the audit log', async () => {
    const uid = await ensureMigrant();
    const actions = await asOwner(async (c) =>
      (await c.query(
        `SELECT subject_type, action FROM audit_log_entry
          WHERE subject_type IN ('identity_link_request','auth_credential','user_account')
            AND (after_value->>'user_id' = $1 OR after_value->>'id' = $1)
          ORDER BY occurred_at`, [uid])).rows,
    );
    const types = new Set(actions.map((a) => `${a.subject_type}.${a.action}`));
    expect(types.has('identity_link_request.insert')).toBe(true);
    expect(types.has('identity_link_request.update')).toBe(true);
    expect(types.has('auth_credential.update')).toBe(true);
    expect(types.has('user_account.update')).toBe(true);
  });

  it('a second open request for the same user is refused', async () => {
    const uid = await userId(USERS.subDrain);
    const idp = await ensureAcquirerIdp();
    const first = await asUser(USERS.qm, async (db) =>
      (await db.query(`SELECT * FROM auth.initiate_identity_link($1,'federated_oidc',$2)`,
                      [uid, idp])).rows[0]);
    await expect(
      asUser(USERS.qm, async (db) =>
        db.query(`SELECT * FROM auth.initiate_identity_link($1,'federated_oidc',$2)`, [uid, idp])),
    ).rejects.toThrow(/identity_link_request_one_open|duplicate key/);
    await asOwner(async (c) => {
      await c.query(`SELECT auth.cancel_identity_link($1,'test cleanup')`, [first.request_id]);
    });
  });

  it('cancellation demands a reason', async () => {
    const uid = await userId(USERS.subDrain);
    const idp = await ensureAcquirerIdp();
    const req = await asUser(USERS.qm, async (db) =>
      (await db.query(`SELECT * FROM auth.initiate_identity_link($1,'federated_oidc',$2)`,
                      [uid, idp])).rows[0]);
    await expect(
      asOwner(async (c) => c.query(`SELECT auth.cancel_identity_link($1,'')`, [req.request_id])),
    ).rejects.toThrow(/LOTLINE_LINK_REASON_REQUIRED/);
    await asOwner(async (c) => {
      await c.query(`SELECT auth.cancel_identity_link($1,'no longer required')`, [req.request_id]);
    });
  });
});
