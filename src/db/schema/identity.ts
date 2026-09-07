import {
  pgTable, uuid, text, boolean, timestamp, jsonb, integer, bigint, inet, customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { citext, daterange } from './_types';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const textArray = customType<{ data: string[] }>({ dataType: () => 'text[]' });

export const organisation = pgTable('organisation', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  legalName: text('legal_name').notNull(),
  tradingName: text('trading_name'),
  abn: text('abn'),
  /** contractor | client | subcontractor | supplier | verifier | consultant | laboratory */
  orgType: text('org_type').notNull(),
  isTenant: boolean('is_tenant').notNull().default(false),
  branding: jsonb('branding').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  supersededById: uuid('superseded_by_id'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  supersedeReason: text('supersede_reason'),
});

export const userAccount = pgTable('user_account', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  email: citext('email').notNull(),
  fullName: text('full_name').notNull(),
  mobileE164: text('mobile_e164'),
  /** invited | active | suspended | departed */
  status: text('status').notNull().default('invited'),
  primaryOrgId: uuid('primary_org_id').notNull().references(() => organisation.id),
  /** home_tenant | federated_oidc | guest_b2b | local_credentials (ADR-0021) */
  authPattern: text('auth_pattern').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  supersededById: uuid('superseded_by_id'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  supersedeReason: text('supersede_reason'),
});

export const orgIdentityProvider = pgTable('org_identity_provider', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  organisationId: uuid('organisation_id').notNull().references(() => organisation.id),
  protocol: text('protocol').notNull(),
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  jwksUri: text('jwks_uri'),
  metadataUrl: text('metadata_url'),
  /** Home-realm discovery: an inbound email domain routes to this provider. */
  allowedEmailDomains: textArray('allowed_email_domains').notNull(),
  enforcesMfa: boolean('enforces_mfa').notNull().default(true),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authIdentity = pgTable('auth_identity', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  /** entra_home | entra_guest | oidc_federated | local */
  provider: text('provider').notNull(),
  orgIdentityProviderId: uuid('org_identity_provider_id').references(() => orgIdentityProvider.id),
  subject: text('subject').notNull(),
  lastAuthenticatedAt: timestamp('last_authenticated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const authCredential = pgTable('auth_credential', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  passwordHash: text('password_hash').notNull(),
  mustChangeAfter: timestamp('must_change_after', { withTimezone: true }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

export const authTotp = pgTable('auth_totp', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  secretEncrypted: bytea('secret_encrypted').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  recoveryCodeHashes: textArray('recovery_code_hashes').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const authPasskey = pgTable('auth_passkey', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  deviceId: uuid('device_id'),
  credentialId: bytea('credential_id').notNull(),
  publicKey: bytea('public_key').notNull(),
  aaguid: text('aaguid'),
  transport: text('transport'),
  signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * Every authentication and unlock, with its strength. signature.authentication_event_id
 * points here, giving the chain: signature <- unlock <- enrolment <- MFA login.
 * Insert-only.
 */
export const authenticationEvent = pgTable('authentication_event', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  deviceId: uuid('device_id'),
  method: text('method').notNull(),
  /** session | device_unlock | step_up */
  strength: text('strength').notNull(),
  mfaSatisfied: boolean('mfa_satisfied').notNull().default(false),
  deviceBoundSession: boolean('device_bound_session').notNull().default(false),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  result: text('result').notNull().default('success'),
  failureReason: text('failure_reason'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export const device = pgTable('device', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id'),
  label: text('label').notNull(),
  platform: text('platform').notNull(),
  deviceFingerprint: text('device_fingerprint').notNull(),
  /** pending | trusted | revoked */
  enrolmentStatus: text('enrolment_status').notNull().default('pending'),
  deviceSecretHash: text('device_secret_hash'),
  isShared: boolean('is_shared').notNull().default(false),
  boundZoneId: uuid('bound_zone_id'),
  enrolledBy: uuid('enrolled_by').references(() => userAccount.id),
  /** The full-MFA event authorising enrolment. Without it, no trust. */
  enrolmentAuthEventId: uuid('enrolment_auth_event_id').references(() => authenticationEvent.id),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
  lastAttestedAt: timestamp('last_attested_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => userAccount.id),
  revokeReason: text('revoke_reason'),
});

/** Binds one user to one trusted device. The PIN maps to an identity, not a device. */
export const deviceUserEnrolment = pgTable('device_user_enrolment', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  deviceId: uuid('device_id').notNull().references(() => device.id),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  /** pin | platform_passkey */
  credentialKind: text('credential_kind').notNull(),
  pinHash: text('pin_hash'),
  passkeyId: uuid('passkey_id').references(() => authPasskey.id),
  /** The user's OWN full authentication that bound them to this device. */
  enrolmentAuthEventId: uuid('enrolment_auth_event_id').notNull()
    .references(() => authenticationEvent.id),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const orgMembership = pgTable('org_membership', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  organisationId: uuid('organisation_id').notNull().references(() => organisation.id),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  /** Null = plain employment. Non-null = an organisation-scoped role (ADR-0023). */
  roleId: uuid('role_id'),
  jobTitle: text('job_title'),
  activePeriod: daterange('active_period').notNull(),
  grantedBy: uuid('granted_by').references(() => userAccount.id),
});
