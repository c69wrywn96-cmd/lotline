import {
  pgTable, uuid, text, boolean, integer, numeric, timestamp, date, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisation, userAccount } from './identity.js';
import { geometry, ltree, daterange, numrange } from './_types.js';

export const unit = pgTable('unit', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  code: text('code').notNull(),
  name: text('name').notNull(),
  dimension: text('dimension').notNull(),
});

/**
 * The named datum every RL in the system is measured against (ADR-0018).
 * Surveyors hand over AHD; an unnamed level is not evidence.
 */
export const verticalDatum = pgTable('vertical_datum', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id'),
  code: text('code').notNull(),
  name: text('name').notNull(),
  realisationNote: text('realisation_note'),
  isLocal: boolean('is_local').notNull().default(false),
  localOriginNote: text('local_origin_note'),
});

export const project = pgTable('project', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  name: text('name').notNull(),
  code: text('code').notNull(),
  clientOrgId: uuid('client_org_id').notNull().references(() => organisation.id),
  status: text('status').notNull().default('delivery'),
  /** 49..56. project_srid is constrained to 7800 + mga_zone. */
  mgaZone: integer('mga_zone').notNull(),
  projectSrid: integer('project_srid').notNull(),
  /** Seeds new records. NEVER used to interpret a stored RL. */
  defaultVerticalDatumId: uuid('default_vertical_datum_id').notNull()
    .references(() => verticalDatum.id),
  boundary: geometry('boundary', { type: 'MultiPolygon', srid: 7844 }),
  deliveryPeriod: daterange('delivery_period'),
  defectsLiabilityEnd: date('defects_liability_end'),
});

export const contract = pgTable('contract', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  contractNumber: text('contract_number').notNull(),
  superintendentUserId: uuid('superintendent_user_id').references(() => userAccount.id),
  verifierOrgId: uuid('verifier_org_id').references(() => organisation.id),
  specSuite: text('spec_suite').notNull(),
  /** not_required (default) | nominated_work_types | all (ADR-0022) */
  clientLotAcceptanceMode: text('client_lot_acceptance_mode').notNull().default('not_required'),
  disclosesCostImpact: boolean('discloses_cost_impact').notNull().default(false),
  clientApprovesMaterials: boolean('client_approves_materials').notNull().default(false),
  clientApprovesDesignChanges: boolean('client_approves_design_changes').notNull().default(false),
  clientApprovesSurvey: boolean('client_approves_survey').notNull().default(false),
  retentionYears: integer('retention_years').notNull().default(10),
});

export const projectParticipant = pgTable('project_participant', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  organisationId: uuid('organisation_id').notNull().references(() => organisation.id),
  participation: text('participation').notNull(),
  jvSharePct: numeric('jv_share_pct'),
  activePeriod: daterange('active_period').notNull(),
});

export const discipline = pgTable('discipline', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
});

export const subcontractPackage = pgTable('subcontract_package', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  subcontractorOrgId: uuid('subcontractor_org_id').notNull().references(() => organisation.id),
  packageCode: text('package_code').notNull(),
  scopeDescription: text('scope_description').notNull(),
});

/** LineStringM: M carries chainage directly, so linear referencing is correct by construction. */
export const alignment = pgTable('alignment', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  name: text('name').notNull(),
  centreline: geometry('centreline', { type: 'LineStringM', srid: 7844 }).notNull(),
  startChainageM: numeric('start_chainage_m').notNull(),
  endChainageM: numeric('end_chainage_m').notNull(),
  sourceSrid: integer('source_srid').notNull(),
  sourceRef: text('source_ref'),
  revision: integer('revision').notNull().default(1),
});

/** Chainage discontinuities. Without these, chainage->coordinate is silently wrong. */
export const alignmentEquation = pgTable('alignment_equation', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  alignmentId: uuid('alignment_id').notNull().references(() => alignment.id),
  backChainageM: numeric('back_chainage_m').notNull(),
  aheadChainageM: numeric('ahead_chainage_m').notNull(),
  reason: text('reason').notNull(),
});

export const zone = pgTable('zone', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  parentZoneId: uuid('parent_zone_id'),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** Derived by trigger from the parent chain. Never set by application code. */
  path: ltree('path').notNull(),
  boundary: geometry('boundary', { type: 'MultiPolygon', srid: 7844 }),
  alignmentId: uuid('alignment_id').references(() => alignment.id),
  chainageRangeM: numrange('chainage_range_m'),
});

export const wbsElement = pgTable('wbs_element', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  parentId: uuid('parent_id'),
  disciplineId: uuid('discipline_id').references(() => discipline.id),
  wbsCode: text('wbs_code').notNull(),
  description: text('description').notNull(),
  path: ltree('path').notNull(),
  budgetQuantity: numeric('budget_quantity'),
  unitId: uuid('unit_id').references(() => unit.id),
});

export const workType = pgTable('work_type', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  disciplineId: uuid('discipline_id').notNull().references(() => discipline.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  defaultUnitId: uuid('default_unit_id').references(() => unit.id),
  geometryKind: text('geometry_kind').notNull(),
  requiresChainage: boolean('requires_chainage').notNull().default(true),
  /** Participates in the pavement layer cake, and is therefore RL-bearing. */
  isLayered: boolean('is_layered').notNull().default(false),
  requiresRl: boolean('requires_rl').notNull().default(false),
});

export const contractAcceptanceWorkType = pgTable('contract_acceptance_work_type', {
  contractId: uuid('contract_id').notNull().references(() => contract.id),
  workTypeId: uuid('work_type_id').notNull().references(() => workType.id),
  rationale: text('rationale').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.contractId, t.workTypeId] }) }));

export const lotNumberScheme = pgTable('lot_number_scheme', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  template: text('template').notNull().default('{zone}-{worktype}-{seq:4}'),
  sequenceScope: text('sequence_scope').notNull().default('zone_worktype'),
});

export const coordinateSystem = pgTable('coordinate_system', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  projectId: uuid('project_id').notNull().references(() => project.id),
  srid: integer('srid').notNull(),
  label: text('label').notNull(),
  isDefaultImport: boolean('is_default_import').notNull().default(false),
});
