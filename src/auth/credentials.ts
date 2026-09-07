/**
 * Local credential authentication — pattern 3 of ADR-0021.
 *
 * Subcontractors and suppliers are frequently ten-person outfits with no
 * enterprise identity. This is their door, so it has to be a good one.
 *
 * Everything here runs on a PRIVILEGED connection, never a user session:
 * authentication happens before there is an identity, so `auth.user_id()` is
 * null and every RLS-protected table reads empty. `auth_credential` and
 * `auth_totp` accordingly have RLS enabled with no permissive policy — they are
 * unreachable through the ordinary data path, by anyone.
 */
import type pg from 'pg';
import { verify as argon2Verify, hash as argon2Hash } from '@node-rs/argon2';
import { createHash, timingSafeEqual } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { openSecret } from './secrets';
import { recordAuthenticationEvent } from './session-bridge';

/** Attempts from ONE SOURCE before that source is locked out of this account. */
export const MAX_FAILED_ATTEMPTS = 5;
/** How long a source stays locked out. */
export const LOCKOUT_MINUTES = 15;
/** Steps either side of the current one that a TOTP code is accepted at. */
export const TOTP_WINDOW = 1;

export type CredentialFailure =
  | 'invalid_credentials'
  | 'locked_out'
  | 'mfa_required'
  | 'invalid_mfa'
  | 'mfa_replayed'
  | 'account_not_active';

export type CredentialResult =
  | { ok: true; userId: string; authEventId: string; usedRecoveryCode: boolean }
  | { ok: false; reason: CredentialFailure };

/**
 * A hash to verify against when the account does not exist.
 *
 * Without this, a missing account returns before doing any KDF work and an
 * unknown address is distinguishable from a known one by response time — an
 * account-enumeration oracle on the sign-in form.
 */
const DUMMY_HASH = argon2Hash('lotline-timing-equaliser');

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface CredentialRow {
  user_id: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
  retired_at: Date | null;
  status: string;
}

/**
 * Verifies an email, password and second factor.
 *
 * The second factor is not optional: an account that has TOTP enrolled cannot
 * sign in without it, and one that has not is refused with `mfa_required`
 * rather than being let through — MFA is a property of the pattern, not a
 * per-user preference.
 */
export async function authenticateWithPassword(
  client: pg.Client | pg.PoolClient,
  input: {
    email: string;
    password: string;
    /** A TOTP code, or one of the user's recovery codes. */
    secondFactor?: string | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
    /**
     * Coarse origin key for lockout. Defaults to the source address. Lockout is
     * keyed on (account, source) so that knowing someone's email address is not
     * enough to deny them service on the morning of a pour (0024).
     */
    sourceKey?: string | undefined;
    now?: Date;
  },
): Promise<CredentialResult> {
  const now = input.now ?? new Date();

  const { rows } = await client.query<CredentialRow>(
    `SELECT c.user_id, c.password_hash, c.failed_attempts, c.locked_until,
            c.retired_at, u.status
       FROM auth_credential c
       JOIN user_account u ON u.id = c.user_id
      WHERE u.email = $1 AND u.superseded_by_id IS NULL`,
    [input.email],
  );
  const cred = rows[0];

  if (!cred) {
    // Equalise the work done, then refuse indistinguishably.
    await argon2Verify(await DUMMY_HASH, input.password).catch(() => false);
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (cred.retired_at) {
    // The account was migrated to another pattern (ADR-0024). The credential is
    // retained for the audit trail but can no longer authenticate.
    await argon2Verify(await DUMMY_HASH, input.password).catch(() => false);
    return { ok: false, reason: 'invalid_credentials' };
  }

  const sourceKey = input.sourceKey ?? input.ip ?? 'unknown';

  // The lock is per SOURCE. An attacker hammering from one origin cannot lock
  // the legitimate origin out, because the counters are separate.
  const posture = await client.query<{ source_locked_until: Date | null; account_delay_seconds: string }>(
    `SELECT * FROM auth.auth_failure_posture($1,$2)`, [cred.user_id, sourceKey]);
  const locked = posture.rows[0]?.source_locked_until ?? null;
  if (locked && locked > now) {
    await recordFailure(client, cred.user_id, 'locked_out', input);
    return { ok: false, reason: 'locked_out' };
  }
  // The ACCOUNT only ever accrues delay. A delay degrades; a lock denies, and
  // denying is what the attacker wanted.
  const delaySeconds = Number(posture.rows[0]?.account_delay_seconds ?? 0);

  if (cred.status !== 'active') {
    await argon2Verify(await DUMMY_HASH, input.password).catch(() => false);
    return { ok: false, reason: 'account_not_active' };
  }

  if (delaySeconds > 0) await sleep(delaySeconds * 1000);

  const passwordOk = await argon2Verify(cred.password_hash, input.password).catch(() => false);
  if (!passwordOk) {
    await registerFailedAttempt(client, cred.user_id, sourceKey);
    await recordFailure(client, cred.user_id, 'bad_password', input);
    return { ok: false, reason: 'invalid_credentials' };
  }

  // Password is right; now the second factor.
  const totp = await loadTotp(client, cred.user_id);
  if (!totp) {
    await recordFailure(client, cred.user_id, 'mfa_not_enrolled', input);
    return { ok: false, reason: 'mfa_required' };
  }
  if (!input.secondFactor) {
    return { ok: false, reason: 'mfa_required' };
  }

  const second = await verifySecondFactor(client, totp, input.secondFactor, now);
  if (second.kind === 'invalid') {
    await registerFailedAttempt(client, cred.user_id, sourceKey);
    await recordFailure(client, cred.user_id, 'bad_totp', input);
    return { ok: false, reason: 'invalid_mfa' };
  }
  if (second.kind === 'replayed') {
    await registerFailedAttempt(client, cred.user_id, sourceKey);
    await recordFailure(client, cred.user_id, 'totp_replayed', input);
    return { ok: false, reason: 'mfa_replayed' };
  }

  await client.query(`SELECT auth.clear_auth_failures($1,$2)`, [cred.user_id, sourceKey]);
  await client.query(
    `UPDATE auth_credential SET failed_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE user_id = $1`,
    [cred.user_id],
  );

  const authEventId = await recordAuthenticationEvent(client, {
    userId: cred.user_id,
    method: second.kind === 'recovery' ? 'recovery_code' : 'password_totp',
    // A recovery code proves possession of a backup list, not of the second
    // factor. deriveStrength() gives it a session and nothing more.
    mfaSatisfied: second.kind === 'totp',
    ip: input.ip,
    userAgent: input.userAgent,
    result: 'success',
  });

  return {
    ok: true,
    userId: cred.user_id,
    authEventId,
    usedRecoveryCode: second.kind === 'recovery',
  };
}

interface TotpRow {
  id: string;
  secret_encrypted: Buffer;
  recovery_code_hashes: string[];
  last_used_counter: string | null;
}

async function loadTotp(
  client: pg.Client | pg.PoolClient, userId: string,
): Promise<TotpRow | null> {
  const { rows } = await client.query<TotpRow>(
    `SELECT id, secret_encrypted, recovery_code_hashes, last_used_counter::text
       FROM auth_totp
      WHERE user_id = $1 AND revoked_at IS NULL AND confirmed_at IS NOT NULL`,
    [userId],
  );
  return rows[0] ?? null;
}

type SecondFactorOutcome =
  | { kind: 'totp' } | { kind: 'recovery' }
  | { kind: 'invalid' } | { kind: 'replayed' };

async function verifySecondFactor(
  client: pg.Client | pg.PoolClient,
  totp: TotpRow,
  submitted: string,
  now: Date,
): Promise<SecondFactorOutcome> {
  const code = submitted.replace(/\s+/g, '');

  const verifier = new TOTP({
    secret: Secret.fromBase32(openSecret(totp.secret_encrypted)),
    digits: 6,
    period: 30,
  });
  const delta = verifier.validate({ token: code, window: TOTP_WINDOW, timestamp: now.getTime() });

  if (delta !== null) {
    const counter = Math.floor(now.getTime() / 1000 / 30) + delta;
    const last = totp.last_used_counter === null ? null : Number(totp.last_used_counter);
    // A code already consumed cannot be used again inside its window.
    if (last !== null && counter <= last) return { kind: 'replayed' };
    await client.query(`UPDATE auth_totp SET last_used_counter = $2 WHERE id = $1`,
                       [totp.id, counter]);
    return { kind: 'totp' };
  }

  // Recovery codes are single use: a consumed one is removed, so a stolen list
  // shrinks as it is spent.
  const submittedHash = sha256(code);
  const match = totp.recovery_code_hashes.find((h) => constantTimeEquals(h, submittedHash));
  if (match) {
    await client.query(
      `UPDATE auth_totp SET recovery_code_hashes = array_remove(recovery_code_hashes, $2)
        WHERE id = $1`,
      [totp.id, match],
    );
    return { kind: 'recovery' };
  }

  return { kind: 'invalid' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerFailedAttempt(
  client: pg.Client | pg.PoolClient, userId: string, sourceKey: string,
): Promise<void> {
  await client.query(
    `SELECT auth.register_auth_failure($1,$2,$3,make_interval(mins => $4))`,
    [userId, sourceKey, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES],
  );
}

/**
 * Failures are recorded as authentication events. A log containing only
 * successes cannot show a brute-force attempt.
 */
async function recordFailure(
  client: pg.Client | pg.PoolClient,
  userId: string,
  reason: string,
  input: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<void> {
  await recordAuthenticationEvent(client, {
    userId,
    method: 'password_totp',
    mfaSatisfied: false,
    ip: input.ip,
    userAgent: input.userAgent,
    result: reason === 'locked_out' ? 'locked_out' : 'failure',
    failureReason: reason,
  });
}
