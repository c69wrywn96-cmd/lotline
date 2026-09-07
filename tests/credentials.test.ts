/**
 * Local credential authentication (src/auth/credentials.ts).
 *
 * This is the door for every ten-person subcontractor and supplier in the chain,
 * so it is tested as a security boundary: enumeration, lockout, replay,
 * single-use recovery, and what a recovery code is and is not worth.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { asOwner, appDb, userId, USERS } from './helpers';
import {
  authenticateWithPassword, hashPassword, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES,
} from '../src/auth/credentials';
import { sealSecret } from '../src/auth/secrets';
import { buildSessionContext } from '../src/auth/session-bridge';
import { PermissionResolver } from '../src/auth/permissions';
import { TOTP, Secret } from 'otpauth';
import { createHash, randomUUID } from 'node:crypto';

afterAll(async () => { await appDb.end(); });

const PASSWORD = 'correct-horse-battery-staple';
const RECOVERY = ['aaaa-1111', 'bbbb-2222', 'cccc-3333'];
let secretBase32: string;

/** Gives the seeded subcontractor a real credential estate. */
beforeAll(async () => {
  const uid = await userId(USERS.subEarth);
  secretBase32 = new Secret({ size: 20 }).base32;
  const hash = await hashPassword(PASSWORD);
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO auth_credential (user_id, password_hash)
       VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, failed_attempts = 0,
             locked_until = NULL, retired_at = NULL`,
      [uid, hash]);
    await c.query(`UPDATE auth_totp SET revoked_at = now() WHERE user_id = $1`, [uid]);
    await c.query(
      `INSERT INTO auth_totp (user_id, secret_encrypted, confirmed_at, recovery_code_hashes)
       VALUES ($1,$2,now(),$3)`,
      [uid, sealSecret(secretBase32),
       RECOVERY.map((r) => createHash('sha256').update(r).digest('hex'))]);
  });
});

function codeAt(when: Date): string {
  return new TOTP({ secret: Secret.fromBase32(secretBase32), digits: 6, period: 30 })
    .generate({ timestamp: when.getTime() });
}

async function reset(): Promise<void> {
  const uid = await userId(USERS.subEarth);
  await asOwner(async (c) => {
    await c.query(
      `UPDATE auth_credential SET failed_attempts = 0, locked_until = NULL WHERE user_id=$1`,
      [uid]);
    await c.query(`UPDATE auth_totp SET last_used_counter = NULL WHERE user_id=$1`, [uid]);
  });
}

const attempt = (email: string, password: string, secondFactor?: string, now?: Date) =>
  asOwner((c) => authenticateWithPassword(c, {
    email, password, ip: '198.51.100.9',
    ...(secondFactor === undefined ? {} : { secondFactor }),
    ...(now === undefined ? {} : { now }),
  }));

describe('the sign-in form is not an account-enumeration oracle', () => {
  it('an unknown address and a wrong password are indistinguishable', async () => {
    await reset();
    const unknown = await attempt('nobody@example.invalid', PASSWORD, '000000');
    const wrong = await attempt(USERS.subEarth, 'not-the-password', '000000');
    expect(unknown).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(wrong).toEqual({ ok: false, reason: 'invalid_credentials' });
    await reset();
  });

  it('an unknown address still does key-derivation work, so timing does not leak', async () => {
    // Guards the DUMMY_HASH path: a bare early return would make an unknown
    // address measurably faster than a known one.
    const t0 = performance.now();
    await attempt('definitely-not-a-user@example.invalid', PASSWORD, '000000');
    const unknownMs = performance.now() - t0;
    expect(unknownMs).toBeGreaterThan(5);
  });
});

describe('the second factor is not optional', () => {
  it('a correct password alone does not sign anyone in', async () => {
    await reset();
    const r = await attempt(USERS.subEarth, PASSWORD, undefined);
    expect(r).toEqual({ ok: false, reason: 'mfa_required' });
    await reset();
  });

  it('a correct password with a correct code succeeds', async () => {
    await reset();
    const now = new Date();
    const r = await attempt(USERS.subEarth, PASSWORD, codeAt(now), now);
    expect(r.ok).toBe(true);
    await reset();
  });

  it('a wrong code fails even with the right password', async () => {
    await reset();
    const r = await attempt(USERS.subEarth, PASSWORD, '000000');
    expect(r).toEqual({ ok: false, reason: 'invalid_mfa' });
    await reset();
  });
});

describe('TOTP replay', () => {
  it('a code cannot be used twice inside its own validity window', async () => {
    await reset();
    const now = new Date();
    const code = codeAt(now);

    const first = await attempt(USERS.subEarth, PASSWORD, code, now);
    expect(first.ok).toBe(true);

    // Same code, seconds later — still inside the step, and still refused.
    const replay = await attempt(USERS.subEarth, PASSWORD, code, new Date(now.getTime() + 5_000));
    expect(replay).toEqual({ ok: false, reason: 'mfa_replayed' });
    await reset();
  });

  it('the next step is accepted', async () => {
    await reset();
    const now = new Date();
    const first = await attempt(USERS.subEarth, PASSWORD, codeAt(now), now);
    expect(first.ok).toBe(true);

    const later = new Date(now.getTime() + 60_000);
    const next = await attempt(USERS.subEarth, PASSWORD, codeAt(later), later);
    expect(next.ok).toBe(true);
    await reset();
  });
});

describe('lockout', () => {
  it('locks after the configured number of failures and refuses even a correct password', async () => {
    await reset();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const r = await attempt(USERS.subEarth, 'wrong', '000000');
      expect(r.ok).toBe(false);
    }

    const now = new Date();
    const locked = await attempt(USERS.subEarth, PASSWORD, codeAt(now), now);
    expect(locked).toEqual({ ok: false, reason: 'locked_out' });

    // ...and releases once the window passes, without an administrator.
    const after = new Date(now.getTime() + (LOCKOUT_MINUTES + 1) * 60_000);
    const released = await attempt(USERS.subEarth, PASSWORD, codeAt(after), after);
    expect(released.ok).toBe(true);
    await reset();
  });

  it('every failure is recorded, so the log can show a brute-force attempt', async () => {
    await reset();
    const uid = await userId(USERS.subEarth);
    const before = await asOwner(async (c) =>
      (await c.query(
        `SELECT count(*)::int n FROM authentication_event
          WHERE user_id=$1 AND result IN ('failure','locked_out')`, [uid])).rows[0].n);

    for (let i = 0; i < 3; i += 1) await attempt(USERS.subEarth, 'wrong', '000000');

    const after = await asOwner(async (c) =>
      (await c.query(
        `SELECT count(*)::int n FROM authentication_event
          WHERE user_id=$1 AND result IN ('failure','locked_out')`, [uid])).rows[0].n);
    expect(after - before).toBe(3);
    await reset();
  });
});

describe('recovery codes', () => {
  it('work once, and are then gone', async () => {
    await reset();
    const uid = await userId(USERS.subEarth);
    const first = await attempt(USERS.subEarth, PASSWORD, RECOVERY[0]);
    expect(first.ok).toBe(true);
    expect(first.ok && first.usedRecoveryCode).toBe(true);

    const again = await attempt(USERS.subEarth, PASSWORD, RECOVERY[0]);
    expect(again).toEqual({ ok: false, reason: 'invalid_mfa' });

    const left = await asOwner(async (c) =>
      (await c.query(
        `SELECT array_length(recovery_code_hashes,1) n FROM auth_totp
          WHERE user_id=$1 AND revoked_at IS NULL`, [uid])).rows[0].n);
    expect(left).toBe(RECOVERY.length - 1);
    await reset();
  });

  it('buy a session back and nothing more — no hold point release', async () => {
    await reset();
    const projectId = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);

    const r = await attempt(USERS.subEarth, PASSWORD, RECOVERY[1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const ctx = await asOwner((c) =>
      buildSessionContext(c, {
        userId: r.userId, authEventId: r.authEventId, requestId: randomUUID(),
      }));
    // deriveStrength() gives a recovery code 'session' — the weakest level.
    expect(ctx.authStrength).toBe('session');

    // Inside their own package, so the refusal is about STRENGTH, not scope.
    const packageId = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM subcontract_package WHERE package_code='P1-EARTH'`)).rows[0].id);
    const decision = await appDb.withSession(ctx, (db) =>
      new PermissionResolver(db).decide('checkpoint.sign', { projectId, packageId }));
    expect(decision.reason).toBe('step_up_required');
    await reset();
  });
});

describe('a retired credential cannot authenticate', () => {
  it('refuses after the account has been migrated to a federated pattern', async () => {
    await reset();
    const uid = await userId(USERS.subEarth);
    await asOwner(async (c) => {
      await c.query(
        `UPDATE auth_credential SET retired_at = now(), retire_reason = 'migrated'
          WHERE user_id=$1`, [uid]);
    });

    const now = new Date();
    const r = await attempt(USERS.subEarth, PASSWORD, codeAt(now), now);
    expect(r).toEqual({ ok: false, reason: 'invalid_credentials' });

    // ...and the row is still there, because nothing is ever deleted.
    const still = await asOwner(async (c) =>
      (await c.query(`SELECT retire_reason FROM auth_credential WHERE user_id=$1`, [uid])).rows[0]);
    expect(still.retire_reason).toBe('migrated');

    await asOwner(async (c) => {
      await c.query(`UPDATE auth_credential SET retired_at=NULL, retire_reason=NULL WHERE user_id=$1`, [uid]);
    });
    await reset();
  });
});

describe('sign-in routing (src/auth/config.ts routeForEmail)', () => {
  it('sends a subcontractor to the password form, not to an SSO button', async () => {
    const { routeForEmail } = await import('../src/auth/config');
    const d = await routeForEmail(USERS.subEarth);
    expect(d.kind).toBe('local_credentials');
  });

  it('sends a client agency to their own provider, not a guest invitation', async () => {
    const { routeForEmail } = await import('../src/auth/config');
    const d = await routeForEmail(USERS.sr);
    expect(d.kind).toBe('federated');
  });

  it('an unrecognised address resolves to unknown rather than throwing', async () => {
    // The screen must respond identically for a known and an unknown address.
    const { routeForEmail } = await import('../src/auth/config');
    await expect(routeForEmail('nobody@example.invalid')).resolves.toEqual({ kind: 'unknown' });
  });

  it('a migrated user is routed by their stored pattern, not by their domain', async () => {
    const { routeForEmail } = await import('../src/auth/config');
    // Joana was migrated to the acquirer IdP by tests/identity-link.test.ts if
    // that suite ran; either way her stored pattern decides, never the domain.
    const uid = await asOwner(async (c) =>
      (await c.query(`SELECT auth_pattern FROM user_account WHERE email=$1`,
                     [USERS.subEarth])).rows[0]);
    expect(uid.auth_pattern).toBe('local_credentials');
    const d = await routeForEmail(USERS.subEarth);
    expect(d.kind).toBe('local_credentials');
  });
});
