/**
 * Permission resolution.
 *
 * This module deliberately contains NO authorisation rules. Every decision is
 * made by `auth.decide()` in the database (migration 0012), because two
 * implementations of an authorisation rule is one implementation and one latent
 * divergence — and the divergence is always discovered in production, by someone
 * who should not have had access.
 *
 * What lives here: a typed permission vocabulary, a per-request cache, and error
 * mapping good enough that the UI can explain a refusal.
 */
import type { SessionClient } from '../db/session.js';

/**
 * The permission vocabulary. Kept in step with the `permission` table by
 * tests/permissions.test.ts, which fails if the two ever disagree in either
 * direction.
 */
export const PERMISSIONS = [
  'lot.view', 'lot.create', 'lot.raise', 'lot.edit', 'lot.geometry.edit',
  'lot.assign', 'lot.bulk_create', 'lot.submit', 'lot.certify_conformance',
  'lot.closeout.approve', 'lot.accept', 'lot.reject', 'lot.hold.impose',
  'lot.hold.lift', 'lot.determine_non_conforming', 'lot.supersede', 'lot.export',
  'itp.master.view', 'itp.master.author', 'itp.master.approve.technical',
  'itp.master.publish', 'itp.master.withdraw', 'itp.instance.view',
  'checkpoint.action', 'checkpoint.evidence.attach', 'checkpoint.sign',
  'checkpoint.hold.release', 'checkpoint.hold.release.retrospective',
  'checkpoint.witness.notify', 'checkpoint.witness.record_outcome',
  'checkpoint.mark_not_applicable', 'checkpoint.correct',
  'checkpoint.correct.countersign', 'signature.withdraw',
  'signature.withdraw.countersign', 'concession.request',
  'concession.approve.em', 'concession.approve.client',
  'admin.project.configure', 'admin.users.manage', 'admin.roles.manage',
  'admin.permission_grant.issue', 'admin.delegation.create',
  'admin.standards.manage', 'admin.acceptance_scheme.manage',
  'admin.integration.configure', 'admin.idp.configure', 'admin.device.enrol',
  'admin.device.revoke', 'admin.device.user_enrol', 'api.key.manage',
  'qa_audit.schedule', 'qa_audit.conduct', 'export.data', 'export.audit_log',
  'pc.sign',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Never delegable, at any strength, by anyone (ADR-0002, guard C9). */
export const NON_DELEGABLE: readonly Permission[] = [
  'checkpoint.hold.release',
  'checkpoint.hold.release.retrospective',
  'lot.certify_conformance',
  'lot.accept',
];

export type DenyReason =
  | 'no_identity'
  | 'unknown_permission'
  | 'not_available_on_shared_device'
  | 'out_of_scope'
  | 'outside_write_scope'
  | 'permission_not_held'
  | 'step_up_required';

export interface Decision {
  allowed: boolean;
  reason: DenyReason | 'allowed';
}

/** The subject a permission is being exercised against. */
export interface Subject {
  projectId: string;
  /** 'read' for visibility, 'write' for any mutation. */
  kind?: 'read' | 'write';
  zonePath?: string;
  wbsPath?: string;
  packageId?: string;
  supplierOrgId?: string;
}

/**
 * Human-readable refusals. `outside_write_scope` is the one that matters most:
 * on a joint venture a partner CAN see the other partner's zone, so pretending
 * the row does not exist would be a lie the user can immediately disprove.
 */
export const DENY_MESSAGE: Record<DenyReason, string> = {
  no_identity: 'Your session has expired. Sign in again.',
  unknown_permission: 'That action is not recognised.',
  not_available_on_shared_device:
    'This action is not available on a shared site device. Use a personal device or the site office.',
  out_of_scope: 'Not found.',
  outside_write_scope: 'This is outside your assigned sections. Ask the section engineer who owns it.',
  permission_not_held: 'Your role does not include this action.',
  step_up_required: 'Confirm your identity to continue.',
};

export class PermissionError extends Error {
  constructor(
    readonly permission: Permission,
    readonly reason: DenyReason,
  ) {
    super(`${permission}: ${reason}`);
    this.name = 'PermissionError';
  }

  get userMessage(): string {
    return DENY_MESSAGE[this.reason];
  }

  /** `out_of_scope` must not leak existence, so it maps to 404, not 403. */
  get httpStatus(): number {
    if (this.reason === 'out_of_scope') return 404;
    if (this.reason === 'no_identity') return 401;
    if (this.reason === 'step_up_required') return 403;
    return 403;
  }
}

/**
 * Per-request memo. A page renders dozens of `can()` calls for the same few
 * permissions; the answers cannot change inside one transaction, because the
 * membership rows they read are not being mutated by the page rendering them.
 */
export class PermissionResolver {
  readonly #db: SessionClient;
  readonly #cache = new Map<string, Decision>();

  constructor(db: SessionClient) {
    this.#db = db;
  }

  async decide(permission: Permission, subject: Subject): Promise<Decision> {
    const kind = subject.kind ?? 'write';
    const key = [
      permission, subject.projectId, kind, subject.zonePath ?? '', subject.wbsPath ?? '',
      subject.packageId ?? '', subject.supplierOrgId ?? '',
    ].join('|');

    const hit = this.#cache.get(key);
    if (hit) return hit;

    const { rows } = await this.#db.query<{ allowed: boolean; reason: DenyReason | 'allowed' }>(
      `SELECT allowed, reason FROM auth.decide($1,$2,$3,$4::ltree,$5::ltree,$6,$7)`,
      [
        permission, subject.projectId, kind,
        subject.zonePath ?? null, subject.wbsPath ?? null,
        subject.packageId ?? null, subject.supplierOrgId ?? null,
      ],
    );
    const decision: Decision = rows[0] ?? { allowed: false, reason: 'no_identity' };
    this.#cache.set(key, decision);
    return decision;
  }

  async can(permission: Permission, subject: Subject): Promise<boolean> {
    return (await this.decide(permission, subject)).allowed;
  }

  /** Throws a PermissionError carrying the reason, for use at a route boundary. */
  async require(permission: Permission, subject: Subject): Promise<void> {
    const decision = await this.decide(permission, subject);
    if (!decision.allowed) {
      throw new PermissionError(permission, decision.reason as DenyReason);
    }
  }

  /**
   * The numeric ceiling this user holds for a permission, e.g. the NCR cost
   * impact above which closeout escalates to the Project Director. Null means
   * no ceiling is configured, which is NOT the same as unlimited — the caller
   * decides what an absent ceiling means for its own action.
   */
  async limit(permission: Permission, projectId: string, key: string): Promise<number | null> {
    const { rows } = await this.#db.query<{ v: string | null }>(
      `SELECT auth.permission_limit($1,$2,$3)::text AS v`,
      [permission, projectId, key],
    );
    const v = rows[0]?.v;
    return v == null ? null : Number(v);
  }
}
