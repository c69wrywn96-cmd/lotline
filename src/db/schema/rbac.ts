import { pgTable, uuid, text, boolean, jsonb, timestamp, primaryKey, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisation, userAccount } from './identity.js';
import { ltree, tstzrange, daterange } from './_types.js';

const textArray = customType<{ data: string[] }>({ dataType: () => 'text[]' });

export const permission = pgTable('permission', {
  code: text('code').primaryKey(),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
  description: text('description').notNull(),
  /** session | device_unlock | step_up — the authentication floor, as data. */
  minAuthStrength: text('min_auth_strength').notNull().default('session'),
  /** False for admin, export and API actions: unavailable on a shared tablet. */
  deviceBoundAllowed: boolean('device_bound_allowed').notNull().default(true),
});

export const role = pgTable('role', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  ownerOrgId: uuid('owner_org_id').references(() => organisation.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** contractor | client | verifier | external */
  side: text('side').notNull(),
  /** organisation | project (ADR-0023) */
  scopeLevel: text('scope_level').notNull().default('project'),
  isSystemTemplate: boolean('is_system_template').notNull().default(false),
  /** Structurally false for every external role. */
  grantsProjectWideRead: boolean('grants_project_wide_read').notNull().default(false),
});

export const rolePermission = pgTable('role_permission', {
  roleId: uuid('role_id').notNull().references(() => role.id),
  permissionCode: text('permission_code').notNull().references(() => permission.code),
  /** Numeric and contextual bounds, e.g. {"max_cost_impact": 50000}. */
  constraintJson: jsonb('constraint_json').notNull().default({}),
}, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionCode] }) }));

export const permissionGrant = pgTable('permission_grant', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  projectId: uuid('project_id'),
  permissionCode: text('permission_code').notNull().references(() => permission.code),
  validPeriod: tstzrange('valid_period').notNull(),
  grantedBy: uuid('granted_by').notNull().references(() => userAccount.id),
  justification: text('justification').notNull(),
});

export const delegation = pgTable('delegation', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id'),
  fromUserId: uuid('from_user_id').notNull().references(() => userAccount.id),
  toUserId: uuid('to_user_id').notNull().references(() => userAccount.id),
  permissionCodes: textArray('permission_codes').notNull(),
  validPeriod: tstzrange('valid_period').notNull(),
  /** Hold release and conformance certification are never delegable. */
  signatureDelegable: boolean('signature_delegable').notNull().default(false),
  reason: text('reason').notNull(),
});

export const projectMembership = pgTable('project_membership', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull(),
  userId: uuid('user_id').notNull().references(() => userAccount.id),
  roleId: uuid('role_id').notNull().references(() => role.id),
  readScopeType: text('read_scope_type').notNull().default('project'),
  readScopeId: uuid('read_scope_id'),
  /** 'none' = read and sign only (Independent Verifier, Auditor). */
  writeScopeType: text('write_scope_type').notNull().default('none'),
  writeScopeId: uuid('write_scope_id'),
  activePeriod: daterange('active_period').notNull(),
  grantedBy: uuid('granted_by').references(() => userAccount.id),
});

/**
 * Trigger-maintained projection. NEVER written by application code — the
 * application holds no INSERT/UPDATE/DELETE grant on it.
 */
export const accessGrant = pgTable('access_grant', {
  userId: uuid('user_id').notNull(),
  projectId: uuid('project_id').notNull(),
  /** read | write — the JV split (ADR-0020). */
  grantKind: text('grant_kind').notNull(),
  scopeType: text('scope_type').notNull(),
  scopeId: uuid('scope_id').notNull(),
  /** Materialised zone/WBS subtree, for GiST containment. */
  scopePath: ltree('scope_path'),
  side: text('side').notNull(),
  /** project_membership | org_membership */
  source: text('source').notNull(),
  sourceId: uuid('source_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.projectId, t.grantKind, t.scopeType, t.scopeId] }),
}));

export const unfrozenColumn = pgTable('unfrozen_column', {
  tableName: text('table_name').notNull(),
  columnName: text('column_name').notNull(),
  reason: text('reason').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.tableName, t.columnName] }) }));
