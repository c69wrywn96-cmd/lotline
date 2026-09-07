/**
 * Device enrolment and management — the data layer.
 *
 * All logic lives here rather than in the components, because this is the
 * feature where a UI can quietly undermine the security model, and a claim like
 * "an administrator cannot set a user's PIN" has to be testable without a
 * browser.
 *
 * The three properties these functions exist to preserve:
 *
 *   1. An administrator enrols a DEVICE. They never enrol a USER on it, and
 *      there is no parameter anywhere here that accepts a PIN or a passkey. An
 *      admin who could set someone's PIN would have become that person.
 *   2. Device trust and user enrolment are separate states, and the UI must not
 *      let the first look like the second. A trusted tablet nobody is enrolled
 *      on cannot sign anything.
 *   3. Revocation is immediate and total, and always available.
 */
import type { SessionClient, SessionContext } from '../../db/session';
import { PermissionResolver } from '../../auth/permissions';

export interface DeviceSummary {
  id: string;
  label: string;
  platform: string;
  enrolmentStatus: 'pending' | 'trusted' | 'revoked';
  isShared: boolean;
  zoneCode: string | null;
  enrolledByName: string | null;
  enrolledAt: Date | null;
  lastAttestedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  /** How many people can currently unlock this device. Zero is meaningful. */
  activeEnrolments: number;
}

export interface EnrolledUser {
  enrolmentId: string;
  userId: string;
  fullName: string;
  email: string;
  credentialKind: 'pin' | 'platform_passkey';
  enrolledAt: Date;
  lockedUntil: Date | null;
  failedAttempts: number;
  /** The user's own MFA event that bound them to this device. */
  boundByMethod: string;
  boundByMfaSatisfied: boolean;
  boundAt: Date;
}

export interface DeviceDetail extends DeviceSummary {
  deviceFingerprint: string;
  /** The enrolment chain: who authorised this device, and how strongly. */
  enrolmentMethod: string | null;
  enrolmentStrength: string | null;
  enrolmentMfaSatisfied: boolean | null;
  enrolledUsers: EnrolledUser[];
}

export async function listDevices(db: SessionClient, projectId: string): Promise<DeviceSummary[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT d.id, d.label, d.platform, d.enrolment_status, d.is_shared,
            z.code AS zone_code, u.full_name AS enrolled_by_name,
            d.enrolled_at, d.last_attested_at, d.revoked_at, d.revoke_reason,
            (SELECT count(*)::int FROM device_user_enrolment due
              WHERE due.device_id = d.id AND due.revoked_at IS NULL) AS active_enrolments
       FROM device d
       LEFT JOIN zone z ON z.id = d.bound_zone_id
       LEFT JOIN user_account u ON u.id = d.enrolled_by
      WHERE d.project_id = $1
      ORDER BY d.enrolment_status, d.label`,
    [projectId],
  );
  return rows.map(toSummary);
}

export async function getDevice(
  db: SessionClient, deviceId: string,
): Promise<DeviceDetail | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT d.id, d.label, d.platform, d.device_fingerprint, d.enrolment_status,
            d.is_shared, z.code AS zone_code, u.full_name AS enrolled_by_name,
            d.enrolled_at, d.last_attested_at, d.revoked_at, d.revoke_reason,
            e.method AS enrolment_method, e.strength AS enrolment_strength,
            e.mfa_satisfied AS enrolment_mfa_satisfied,
            (SELECT count(*)::int FROM device_user_enrolment due
              WHERE due.device_id = d.id AND due.revoked_at IS NULL) AS active_enrolments
       FROM device d
       LEFT JOIN zone z ON z.id = d.bound_zone_id
       LEFT JOIN user_account u ON u.id = d.enrolled_by
       LEFT JOIN authentication_event e ON e.id = d.enrolment_auth_event_id
      WHERE d.id = $1`,
    [deviceId],
  );
  const row = rows[0];
  if (!row) return null;   // RLS may also have hidden it; the caller renders 404

  const { rows: users } = await db.query<Record<string, unknown>>(
    `SELECT due.id AS enrolment_id, due.user_id, ua.full_name, ua.email::text AS email,
            due.credential_kind, due.enrolled_at, due.locked_until, due.failed_attempts,
            ev.method AS bound_by_method, ev.mfa_satisfied AS bound_by_mfa_satisfied,
            ev.occurred_at AS bound_at
       FROM device_user_enrolment due
       JOIN user_account ua ON ua.id = due.user_id
       JOIN authentication_event ev ON ev.id = due.enrolment_auth_event_id
      WHERE due.device_id = $1 AND due.revoked_at IS NULL
      ORDER BY ua.full_name`,
    [deviceId],
  );

  return {
    ...toSummary(row),
    deviceFingerprint: row.device_fingerprint as string,
    enrolmentMethod: (row.enrolment_method as string | null) ?? null,
    enrolmentStrength: (row.enrolment_strength as string | null) ?? null,
    enrolmentMfaSatisfied: (row.enrolment_mfa_satisfied as boolean | null) ?? null,
    enrolledUsers: users.map((u) => ({
      enrolmentId: u.enrolment_id as string,
      userId: u.user_id as string,
      fullName: u.full_name as string,
      email: u.email as string,
      credentialKind: u.credential_kind as 'pin' | 'platform_passkey',
      enrolledAt: u.enrolled_at as Date,
      lockedUntil: (u.locked_until as Date | null) ?? null,
      failedAttempts: u.failed_attempts as number,
      boundByMethod: u.bound_by_method as string,
      boundByMfaSatisfied: u.bound_by_mfa_satisfied as boolean,
      boundAt: u.bound_at as Date,
    })),
  };
}

function toSummary(row: Record<string, unknown>): DeviceSummary {
  return {
    id: row.id as string,
    label: row.label as string,
    platform: row.platform as string,
    enrolmentStatus: row.enrolment_status as DeviceSummary['enrolmentStatus'],
    isShared: row.is_shared as boolean,
    zoneCode: (row.zone_code as string | null) ?? null,
    enrolledByName: (row.enrolled_by_name as string | null) ?? null,
    enrolledAt: (row.enrolled_at as Date | null) ?? null,
    lastAttestedAt: (row.last_attested_at as Date | null) ?? null,
    revokedAt: (row.revoked_at as Date | null) ?? null,
    revokeReason: (row.revoke_reason as string | null) ?? null,
    activeEnrolments: row.active_enrolments as number,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export class DeviceActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeviceActionError';
  }
}

export interface EnrolDeviceInput {
  projectId: string;
  label: string;
  platform: string;
  deviceFingerprint: string;
  isShared: boolean;
  boundZoneId?: string | undefined;
}

/**
 * Enrols a device as trusted.
 *
 * NOTE what this function does NOT take: any user credential. Enrolling a device
 * establishes that the hardware is ours. It says nothing about who may unlock
 * it, and it cannot — see authoriseUserEnrolment below.
 *
 * The session's own authentication event becomes the device's enrolment event,
 * so the device's trust is anchored to a specific, recorded, MFA-satisfied login
 * by a named person. The database refuses anything weaker
 * (LOTLINE_DEVICE_ENROLMENT_WEAK).
 */
export async function enrolDevice(
  db: SessionClient, ctx: SessionContext, input: EnrolDeviceInput,
): Promise<string> {
  await new PermissionResolver(db).require('admin.device.enrol', { projectId: input.projectId });

  if (!ctx.authEventId) {
    throw new DeviceActionError(
      'no_auth_event',
      'This session has no recorded authentication event, so it cannot anchor a device enrolment.',
    );
  }
  if (ctx.deviceBound) {
    // Bootstrapping trust from an already-shared device would let whoever is
    // holding the tablet enrol another one. permission.device_bound_allowed is
    // false for this action; this check exists so the UI can explain it rather
    // than surfacing a bare policy failure.
    throw new DeviceActionError(
      'not_on_shared_device',
      'Devices are enrolled from a personal device, not from a shared site device.',
    );
  }
  if (!input.label.trim()) {
    throw new DeviceActionError('label_required', 'Give the device a label people will recognise on site.');
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO device (project_id, label, platform, device_fingerprint, enrolment_status,
                         is_shared, bound_zone_id, enrolled_by, enrolment_auth_event_id, enrolled_at)
     VALUES ($1,$2,$3,$4,'trusted',$5,$6,$7,$8, now())
     RETURNING id`,
    [
      input.projectId, input.label.trim(), input.platform, input.deviceFingerprint,
      input.isShared, input.boundZoneId ?? null, ctx.userId, ctx.authEventId,
    ],
  );
  return rows[0]!.id;
}

/**
 * Revokes a device. Immediate and total: any open session resting on it is
 * refused at the next request by the session bridge, without waiting for
 * expiry.
 */
export async function revokeDevice(
  db: SessionClient, ctx: SessionContext,
  deviceId: string, projectId: string, reason: string,
): Promise<void> {
  await new PermissionResolver(db).require('admin.device.revoke', { projectId });
  if (!reason.trim()) {
    throw new DeviceActionError('reason_required',
      'Record why the device is being revoked — lost, replaced, or left on site.');
  }
  const { rowCount } = await db.query(
    `UPDATE device SET enrolment_status = 'revoked', revoked_at = now(),
                       revoked_by = $2, revoke_reason = $3, updated_at = now()
      WHERE id = $1 AND enrolment_status <> 'revoked'`,
    [deviceId, ctx.userId, reason.trim()],
  );
  if (!rowCount) {
    throw new DeviceActionError('not_found', 'That device is not available, or is already revoked.');
  }
}

/**
 * Revokes ONE person's ability to unlock a device, leaving the device itself
 * trusted. This is the common case — someone leaves the crew, the tablet stays.
 */
export async function revokeUserEnrolment(
  db: SessionClient, _ctx: SessionContext,
  enrolmentId: string, projectId: string,
): Promise<void> {
  await new PermissionResolver(db).require('admin.device.revoke', { projectId });
  const { rowCount } = await db.query(
    `UPDATE device_user_enrolment SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [enrolmentId],
  );
  if (!rowCount) {
    throw new DeviceActionError('not_found', 'That enrolment is not available, or is already revoked.');
  }
}

/**
 * What an administrator CAN do about user enrolment: confirm that a person is
 * expected on a device. That is all.
 *
 * The enrolment itself cannot be performed here, by anyone, because
 * device_user_enrolment.enrolment_auth_event_id must reference the USER'S OWN
 * successful MFA authentication (migration 0002,
 * LOTLINE_USER_ENROLMENT_MISMATCH). The user completes it on the device, with
 * their own credentials, and chooses their own PIN or passkey.
 *
 * There is deliberately no `pin` parameter on this function or anywhere else in
 * this module.
 */
export async function describeUserEnrolmentProcess(
  db: SessionClient, projectId: string,
): Promise<{ canAuthorise: boolean; steps: readonly string[] }> {
  const canAuthorise = await new PermissionResolver(db)
    .can('admin.device.user_enrol', { projectId });
  return {
    canAuthorise,
    steps: [
      'The person signs in on this device with their own credentials and full multi-factor authentication.',
      'They choose their own PIN, or register a passkey if the device supports one.',
      'Their unlock is bound to that authentication — nobody else, including an administrator, can set it for them.',
    ],
  };
}
