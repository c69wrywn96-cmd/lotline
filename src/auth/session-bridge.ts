/**
 * Turns an authenticated request into a database SessionContext.
 *
 * This is the seam where authentication becomes authorisation. Every field it
 * produces is consumed by RLS or by auth.decide(), so a mistake here is a
 * security bug rather than a bug: the deliberate posture throughout is that an
 * absent or unreadable input yields the LEAST privilege, never the most.
 */
import type pg from 'pg';
import type { SessionContext } from '../db/session';
import { deriveStrength, type AuthMethod, type AuthStrength } from './strength';

export interface RequestIdentity {
  userId: string;
  /** The authentication_event this session rests on. */
  authEventId: string;
  requestId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  /** Present when the request arrives from an enrolled device. */
  deviceId?: string | undefined;
}

export interface AuthEventRow {
  id: string;
  user_id: string;
  device_id: string | null;
  method: AuthMethod;
  mfa_satisfied: boolean;
  device_bound_session: boolean;
  result: string;
  occurred_at: Date;
}

export class SessionRejected extends Error {
  constructor(readonly reason:
    | 'auth_event_missing'
    | 'auth_event_failed'
    | 'auth_event_user_mismatch'
    | 'device_not_trusted'
    | 'device_user_not_enrolled') {
    super(reason);
    this.name = 'SessionRejected';
  }
}

/**
 * Rebuilds the session's authentication strength from the stored event on every
 * request, rather than trusting a value carried in a cookie or a JWT.
 *
 * A client-supplied strength claim would be the whole authorisation model in the
 * hands of the caller: anyone able to set a cookie could assert `step_up` and
 * release a hold point. Recomputing costs one indexed lookup and makes the
 * strength a property of what actually happened.
 */
export async function buildSessionContext(
  client: pg.Client | pg.PoolClient,
  identity: RequestIdentity,
  now: Date = new Date(),
): Promise<SessionContext> {
  const { rows } = await client.query<AuthEventRow>(
    `SELECT id, user_id, device_id, method, mfa_satisfied, device_bound_session,
            result, occurred_at
       FROM authentication_event WHERE id = $1`,
    [identity.authEventId],
  );
  const event = rows[0];
  if (!event) throw new SessionRejected('auth_event_missing');
  if (event.result !== 'success') throw new SessionRejected('auth_event_failed');
  if (event.user_id !== identity.userId) throw new SessionRejected('auth_event_user_mismatch');

  const deviceBound = event.device_bound_session || identity.deviceId != null;

  if (identity.deviceId) {
    // A device that has been revoked since sign-in must not carry the session
    // any further, and a user must be enrolled on the device they claim to be
    // holding — the PIN binds an identity, not a device (ADR-0021).
    const { rows: dev } = await client.query<{ enrolment_status: string; enrolled: boolean }>(
      `SELECT d.enrolment_status,
              EXISTS (SELECT 1 FROM device_user_enrolment due
                       WHERE due.device_id = d.id AND due.user_id = $2
                         AND due.revoked_at IS NULL) AS enrolled
         FROM device d WHERE d.id = $1`,
      [identity.deviceId, identity.userId],
    );
    const d = dev[0];
    if (!d || d.enrolment_status !== 'trusted') throw new SessionRejected('device_not_trusted');
    if (!d.enrolled) throw new SessionRejected('device_user_not_enrolled');
  }

  const ageSeconds = Math.max(0, (now.getTime() - event.occurred_at.getTime()) / 1000);
  const authStrength: AuthStrength = deriveStrength({
    method: event.method,
    mfaSatisfied: event.mfa_satisfied,
    ageSeconds,
    deviceBound,
  });

  return {
    userId: identity.userId,
    requestId: identity.requestId,
    authEventId: identity.authEventId,
    authStrength,
    deviceBound,
    ...(identity.ip !== undefined ? { ip: identity.ip } : {}),
    ...(identity.userAgent !== undefined ? { userAgent: identity.userAgent } : {}),
    ...(identity.deviceId !== undefined ? { deviceId: identity.deviceId } : {}),
  };
}

/**
 * Records an authentication attempt. Failures are recorded too — an audit that
 * only contains successes cannot show a brute-force attempt.
 */
export async function recordAuthenticationEvent(
  client: pg.Client | pg.PoolClient,
  input: {
    userId: string;
    method: AuthMethod;
    mfaSatisfied: boolean;
    deviceId?: string | undefined;
    deviceBoundSession?: boolean | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
    result?: 'success' | 'failure' | 'locked_out';
    failureReason?: string | undefined;
  },
): Promise<string> {
  const strength = deriveStrength({
    method: input.method,
    mfaSatisfied: input.mfaSatisfied,
    ageSeconds: 0,
    deviceBound: input.deviceBoundSession ?? false,
  });
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO authentication_event
       (user_id, device_id, method, strength, mfa_satisfied, device_bound_session,
        ip_address, user_agent, result, failure_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.userId, input.deviceId ?? null, input.method, strength, input.mfaSatisfied,
      input.deviceBoundSession ?? false, input.ip ?? null, input.userAgent ?? null,
      input.result ?? 'success', input.failureReason ?? null,
    ],
  );
  return rows[0]!.id;
}
