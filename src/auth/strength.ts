/**
 * Deriving a session's authentication strength (ADR-0021, §10).
 *
 * Kept separate from the Auth.js callbacks so the rules are testable without a
 * browser, an IdP or a running server — these decide whether someone may release
 * a hold point, so "we tested it by clicking around" is not good enough.
 */

export type AuthStrength = 'session' | 'device_unlock' | 'step_up';

export type AuthMethod =
  | 'idp_primary' | 'idp_reauth' | 'password_totp'
  | 'device_pin' | 'device_passkey' | 'passkey' | 'recovery_code';

export interface StrengthInput {
  method: AuthMethod;
  mfaSatisfied: boolean;
  /** Seconds since the authentication event. */
  ageSeconds: number;
  /** True when running on a shared, enrolled site device. */
  deviceBound: boolean;
}

/**
 * A step-up is a statement about *now*, not about earlier today. Re-authenticating
 * at 7am does not authorise a hold point release at 4pm, so step-up decays.
 */
export const STEP_UP_TTL_SECONDS = 15 * 60;

/** A device unlock lasts a shift-realistic interval before it must be repeated. */
export const DEVICE_UNLOCK_TTL_SECONDS = 12 * 60 * 60;

export function deriveStrength(input: StrengthInput): AuthStrength {
  const { method, mfaSatisfied, ageSeconds, deviceBound } = input;

  const grantsStepUp =
    method === 'idp_reauth' ||
    method === 'passkey' ||
    method === 'device_passkey' ||
    (method === 'idp_primary' && mfaSatisfied) ||
    (method === 'password_totp' && mfaSatisfied);

  if (grantsStepUp && ageSeconds <= STEP_UP_TTL_SECONDS) return 'step_up';

  // A recovery code proves possession of a backup secret, not of the second
  // factor. It gets a session back, never a hold point release.
  if (method === 'recovery_code') return 'session';

  const grantsUnlock =
    method === 'device_pin' ||
    method === 'device_passkey' ||
    method === 'idp_primary' ||
    method === 'idp_reauth' ||
    (method === 'password_totp' && mfaSatisfied);

  if (!grantsUnlock) return 'session';

  // A shared tablet decays faster: the next person to pick it up must be the
  // one who unlocked it.
  const ttl = deviceBound ? DEVICE_UNLOCK_TTL_SECONDS / 4 : DEVICE_UNLOCK_TTL_SECONDS;
  return ageSeconds <= ttl ? 'device_unlock' : 'session';
}

/**
 * Whether an action needing `required` may proceed at `held`, so a route can
 * decide between refusing and prompting for step-up.
 */
export function satisfies(held: AuthStrength, required: AuthStrength): boolean {
  const rank: Record<AuthStrength, number> = { session: 1, device_unlock: 2, step_up: 3 };
  return rank[held] >= rank[required];
}
