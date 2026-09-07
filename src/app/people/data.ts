/**
 * User and role management — the data layer.
 *
 * A solved shape, with one part that is not: changing what someone can do is
 * itself a consequential act. Every mutation here requires step-up, is audited
 * with before/after values by the database trigger, and — critically — cannot
 * be used to widen your own authority.
 */
import type { SessionClient, SessionContext } from '../../db/session';
import { PermissionResolver } from '../../auth/permissions';

export interface PersonSummary {
  userId: string;
  fullName: string;
  email: string;
  status: string;
  authPattern: string;
  organisation: string;
  organisationType: string;
  /** Roles held on THIS project, plus any organisation-scoped role. */
  roles: { code: string; name: string; scopeLevel: string; via: string }[];
  readScope: string | null;
  writeScope: string | null;
  side: string | null;
  lastAuthenticatedAt: Date | null;
}

export async function listPeople(
  db: SessionClient, projectId: string,
): Promise<PersonSummary[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT u.id                AS user_id,
            u.full_name, u.email::text AS email, u.status, u.auth_pattern,
            o.legal_name        AS organisation,
            o.org_type          AS organisation_type,
            (SELECT max(g.side) FROM access_grant g
              WHERE g.user_id = u.id AND g.project_id = $1) AS side,
            (SELECT max(g.scope_type) FROM access_grant g
              WHERE g.user_id = u.id AND g.project_id = $1 AND g.grant_kind = 'read') AS read_scope,
            (SELECT max(g.scope_type) FROM access_grant g
              WHERE g.user_id = u.id AND g.project_id = $1 AND g.grant_kind = 'write') AS write_scope,
            (SELECT max(ai.last_authenticated_at) FROM auth_identity ai
              WHERE ai.user_id = u.id) AS last_authenticated_at,
            COALESCE(
              (SELECT jsonb_agg(jsonb_build_object(
                        'code', r.code, 'name', r.name,
                        'scopeLevel', r.scope_level, 'via', 'project')
                      ORDER BY r.code)
                 FROM project_membership pm
                 JOIN role r ON r.id = pm.role_id
                WHERE pm.user_id = u.id AND pm.project_id = $1
                  AND pm.active_period @> CURRENT_DATE),
              '[]'::jsonb)
            ||
            COALESCE(
              (SELECT jsonb_agg(jsonb_build_object(
                        'code', r.code, 'name', r.name,
                        'scopeLevel', r.scope_level, 'via', 'organisation')
                      ORDER BY r.code)
                 FROM org_membership om
                 JOIN role r ON r.id = om.role_id
                 JOIN project_participant pp ON pp.organisation_id = om.organisation_id
                WHERE om.user_id = u.id AND om.role_id IS NOT NULL
                  AND om.active_period @> CURRENT_DATE
                  AND pp.project_id = $1 AND pp.active_period @> CURRENT_DATE),
              '[]'::jsonb) AS roles
       FROM user_account u
       JOIN organisation o ON o.id = u.primary_org_id
      WHERE EXISTS (SELECT 1 FROM access_grant g
                     WHERE g.user_id = u.id AND g.project_id = $1)
      ORDER BY o.legal_name, u.full_name`,
    [projectId],
  );

  return rows.map((r) => ({
    userId: r.user_id as string,
    fullName: r.full_name as string,
    email: r.email as string,
    status: r.status as string,
    authPattern: r.auth_pattern as string,
    organisation: r.organisation as string,
    organisationType: r.organisation_type as string,
    roles: (r.roles as PersonSummary['roles']) ?? [],
    readScope: (r.read_scope as string | null) ?? null,
    writeScope: (r.write_scope as string | null) ?? null,
    side: (r.side as string | null) ?? null,
    lastAuthenticatedAt: (r.last_authenticated_at as Date | null) ?? null,
  }));
}

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  side: string;
  scopeLevel: string;
  isSystemTemplate: boolean;
  grantsProjectWideRead: boolean;
  permissionCount: number;
  stepUpCount: number;
}

export async function listRoles(db: SessionClient): Promise<RoleSummary[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT r.id, r.code, r.name, r.side, r.scope_level, r.is_system_template,
            r.grants_project_wide_read,
            count(rp.permission_code)::int AS permission_count,
            count(rp.permission_code) FILTER (WHERE p.min_auth_strength = 'step_up')::int
              AS step_up_count
       FROM role r
       LEFT JOIN role_permission rp ON rp.role_id = r.id
       LEFT JOIN permission p ON p.code = rp.permission_code
      GROUP BY r.id
      ORDER BY r.scope_level DESC, r.side, r.code`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    side: r.side as string,
    scopeLevel: r.scope_level as string,
    isSystemTemplate: r.is_system_template as boolean,
    grantsProjectWideRead: r.grants_project_wide_read as boolean,
    permissionCount: r.permission_count as number,
    stepUpCount: r.step_up_count as number,
  }));
}

export class PeopleActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PeopleActionError';
  }
}

export interface GrantMembershipInput {
  projectId: string;
  userId: string;
  roleId: string;
  readScopeType?: 'project' | 'zone' | 'wbs' | 'package' | 'crew' | 'supplier_org';
  readScopeId?: string | undefined;
  writeScopeType?: 'none' | 'project' | 'zone' | 'wbs' | 'package' | 'crew' | 'supplier_org';
  writeScopeId?: string | undefined;
}

/**
 * Grants a project membership.
 *
 * The one rule that is not ordinary CRUD: **you cannot grant yourself
 * anything.** Self-service escalation is the single most valuable move an
 * attacker can make with a compromised administrator session, and it is also the
 * hardest to notice in an audit log full of legitimate membership changes.
 * Someone else has to do it, which makes the escalation take two accounts.
 */
export async function grantMembership(
  db: SessionClient, ctx: SessionContext, input: GrantMembershipInput,
): Promise<string> {
  await new PermissionResolver(db)
    .require('admin.users.manage', { projectId: input.projectId });

  if (input.userId === ctx.userId) {
    throw new PeopleActionError(
      'no_self_grant',
      'You cannot grant a role to yourself. Ask another administrator — an escalation should take two accounts, not one.',
    );
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO project_membership
       (project_id, user_id, role_id, read_scope_type, read_scope_id,
        write_scope_type, write_scope_id, granted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      input.projectId, input.userId, input.roleId,
      input.readScopeType ?? 'project', input.readScopeId ?? null,
      input.writeScopeType ?? 'none', input.writeScopeId ?? null,
      ctx.userId,
    ],
  );
  return rows[0]!.id;
}

/**
 * Ends a membership by closing its active period. Nothing is deleted: the row
 * stays, the access lapses, and the audit log shows both (ADR-0003).
 */
export async function endMembership(
  db: SessionClient, ctx: SessionContext,
  membershipId: string, projectId: string, reason?: string,
): Promise<void> {
  await new PermissionResolver(db).require('admin.users.manage', { projectId });

  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM project_membership WHERE id = $1 AND project_id = $2`,
    [membershipId, projectId],
  );
  const target = rows[0];
  if (!target) {
    throw new PeopleActionError('not_found', 'That membership is not available.');
  }
  if (target.user_id === ctx.userId) {
    // Symmetric with the grant rule. Removing your own last membership would
    // also lock you out of the project you are administering.
    throw new PeopleActionError(
      'no_self_revoke',
      'You cannot end your own membership. Ask another administrator.',
    );
  }

  // active_period stays the access gate. A membership granted and ended on the
  // same day collapses to an empty range, so the fact of the ending is recorded
  // explicitly rather than inferred from a null upper bound (migration 0021).
  await db.query(
    `UPDATE project_membership
        SET active_period = daterange(lower(active_period), CURRENT_DATE, '[)'),
            ended_at = now(), ended_by = $2, end_reason = $3,
            updated_at = now(), updated_by = $2
      WHERE id = $1`,
    [membershipId, ctx.userId, reason ?? null],
  );
}

/**
 * The membership changes made on a project, newest first — read straight from
 * the audit log rather than a separate table, so it cannot drift from what
 * actually happened.
 */
export interface MembershipChange {
  occurredAt: Date;
  actorName: string | null;
  action: string;
  subjectUserId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export async function listMembershipChanges(
  db: SessionClient, projectId: string, limit = 50,
): Promise<MembershipChange[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT a.occurred_at, a.action, a.before_value, a.after_value,
            u.full_name AS actor_name,
            COALESCE(a.after_value->>'user_id', a.before_value->>'user_id') AS subject_user_id
       FROM audit_log_entry a
       LEFT JOIN user_account u ON u.id = a.actor_user_id
      WHERE a.project_id = $1 AND a.subject_type = 'project_membership'
      ORDER BY a.occurred_at DESC
      LIMIT $2`,
    [projectId, limit],
  );
  return rows.map((r) => ({
    occurredAt: r.occurred_at as Date,
    actorName: (r.actor_name as string | null) ?? null,
    action: r.action as string,
    subjectUserId: (r.subject_user_id as string | null) ?? null,
    before: (r.before_value as Record<string, unknown> | null) ?? null,
    after: (r.after_value as Record<string, unknown> | null) ?? null,
  }));
}
