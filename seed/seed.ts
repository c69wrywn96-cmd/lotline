/**
 * Seeds one realistic project: a two-partner joint venture on a road upgrade,
 * with real chainage, a chainage equation, nested zones and WBS, two
 * subcontract packages, a supplier, and users across every role and every
 * authentication pattern.
 *
 * Real rows through the real schema. No fixtures pretending to be data.
 */
import pg from 'pg';

const url = process.env.DATABASE_URL_OWNER ?? 'postgres://postgres:postgres@localhost:5432/lotline';

/** Deterministic ids so tests can address seeded rows by name, not by scan. */
export const SEED = {
  project: 'Mulgoa Road Upgrade Stage 2',
  projectCode: 'MRU2',
} as const;

async function main() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');

  /** Strict lookup: a missing seed key is a bug, not a nullable value. */
  const req = (m: Record<string, string>, k: string): string => {
    const v = m[k];
    if (v === undefined) throw new Error(`seed: missing key ${k}`);
    return v;
  };

  const one = async (sql: string, params: unknown[] = []): Promise<any> => {
    const r = await c.query(sql, params as any[]);
    return r.rows[0];
  };

  // -- Organisations -------------------------------------------------------
  // A JV of two Tier 1 contractors, the client, the Superintendent's firm, an
  // independent verifier, two subcontractors, a supplier and a NATA laboratory.
  const orgs: Record<string, string> = {};
  for (const [key, name, abn, type, tenant] of [
    ['jvA', 'Northbound Civil Pty Ltd', '11000000001', 'contractor', true],
    ['jvB', 'Kellerman Constructions Pty Ltd', '11000000002', 'contractor', true],
    ['client', 'Transport for NSW', '11000000003', 'client', false],
    ['super', 'Ardent Superintendency Pty Ltd', '11000000004', 'consultant', false],
    ['iv', 'Meridian Independent Verification Pty Ltd', '11000000005', 'verifier', false],
    ['subEarth', 'Vellacott Earthmoving Pty Ltd', '11000000006', 'subcontractor', false],
    ['subDrain', 'Rowe Drainage Pty Ltd', '11000000007', 'subcontractor', false],
    ['supplier', 'Hawkesbury Premix Pty Ltd', '11000000008', 'supplier', false],
    ['lab', 'Nepean Materials Testing Pty Ltd', '11000000009', 'laboratory', false],
  ] as const) {
    const row = await one(
      `INSERT INTO organisation (legal_name, abn, org_type, is_tenant)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, abn, type, tenant],
    );
    orgs[key] = row.id;
  }

  // -- Project and contract ------------------------------------------------
  // Western Sydney: MGA2020 Zone 56 (EPSG:7856), levels to AHD71.
  const ahd = await one(`SELECT id FROM vertical_datum WHERE code = 'AHD71'`);
  const project = await one(
    `INSERT INTO project (name, code, client_org_id, status, mga_zone, project_srid,
                          default_vertical_datum_id, delivery_period, defects_liability_end)
     VALUES ($1,$2,$3,'delivery',56,7856,$4,
             daterange(DATE '2025-02-03', DATE '2027-06-30','[)'), DATE '2028-06-30')
     RETURNING id`,
    [SEED.project, SEED.projectCode, req(orgs, 'client'), ahd.id],
  );

  await one(
    `INSERT INTO contract (project_id, contract_number, spec_suite,
                           client_lot_acceptance_mode, discloses_cost_impact, retention_years)
     VALUES ($1,'TfNSW-2024-MRU2-0031','TfNSW','not_required', false, 10) RETURNING id`,
    [project.id],
  );

  for (const [org, participation, share] of [
    [req(orgs, 'jvA'), 'lead_contractor', 60],
    [req(orgs, 'jvB'), 'jv_partner', 40],
    [req(orgs, 'client'), 'client', null],
    [req(orgs, 'super'), 'superintendent', null],
    [req(orgs, 'iv'), 'verifier', null],
    [req(orgs, 'subEarth'), 'subcontractor', null],
    [req(orgs, 'subDrain'), 'subcontractor', null],
    [req(orgs, 'supplier'), 'supplier', null],
    [req(orgs, 'lab'), 'consultant', null],
  ] as const) {
    await c.query(
      `INSERT INTO project_participant (project_id, organisation_id, participation, jv_share_pct)
       VALUES ($1,$2,$3,$4)`,
      [project.id, org, participation, share],
    );
  }

  // -- Units, disciplines, alignment ---------------------------------------
  const units: Record<string, string> = {};
  for (const [code, name, dim] of [
    ['m3', 'Cubic metre', 'volume'],
    ['m2', 'Square metre', 'area'],
    ['m', 'Metre', 'length'],
    ['t', 'Tonne', 'mass'],
    ['ea', 'Each', 'count'],
  ] as const) {
    const r = await one(
      `INSERT INTO unit (code,name,dimension) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [code, name, dim],
    );
    units[code] = r.id;
  }

  const disciplines: Record<string, string> = {};
  for (const [code, name] of [
    ['CIV', 'Civil'],
    ['PAV', 'Pavement'],
    ['DRN', 'Drainage'],
    ['STR', 'Structures'],
  ] as const) {
    const r = await one(
      `INSERT INTO discipline (project_id, code, name) VALUES ($1,$2,$3) RETURNING id`,
      [project.id, code, name],
    );
    disciplines[code] = r.id;
  }

  // Mainline alignment, CH 0 to CH 3200, as LineStringM with M carrying
  // chainage directly (ADR-0005). Coordinates are around Mulgoa Road, Penrith.
  const alignment = await one(
    `INSERT INTO alignment (project_id, name, centreline, start_chainage_m, end_chainage_m,
                            source_srid, source_ref, revision)
     VALUES ($1,'Mulgoa Road Mainline MC01',
             ST_GeomFromText('LINESTRINGM(150.6890 -33.7720 0,
                                          150.6905 -33.7650 800,
                                          150.6921 -33.7580 1600,
                                          150.6938 -33.7510 2400,
                                          150.6955 -33.7440 3200)', 7844),
             0, 3200, 7856, 'MRU2-ALN-MC01-RevC.xml', 3)
     RETURNING id`,
    [project.id],
  );

  // A real chainage equation: the Stage 2 realignment shortened the mainline by
  // 40 m at CH 1800 without re-chainaging downstream.
  await c.query(
    `INSERT INTO alignment_equation (alignment_id, back_chainage_m, ahead_chainage_m, reason)
     VALUES ($1, 1800, 1840, 'Stage 2 realignment, MC01 Rev C. Chainage not re-run downstream.')`,
    [alignment.id],
  );

  // -- Zones: JV partners split geographically -----------------------------
  const zones: Record<string, string> = {};
  const mkZone = async (code: string, name: string, parent: string | null, chLo?: number, chHi?: number) => {
    const r = await one(
      `INSERT INTO zone (project_id, parent_zone_id, code, name, alignment_id, chainage_range_m)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, path`,
      [project.id, parent, code, name, alignment.id,
       chLo === undefined ? null : `[${chLo},${chHi})`],
    );
    zones[code] = r.id;
    return r;
  };
  await mkZone('North', 'Northern sections', null, 0, 1600);
  await mkZone('South', 'Southern sections', null, 1600, 3200);
  await mkZone('Z3', 'Zone 3 — CH 1200 to CH 1600', req(zones, 'North'), 1200, 1600);
  await mkZone('Z2', 'Zone 2 — CH 800 to CH 1200', req(zones, 'North'), 800, 1200);
  await mkZone('Z5', 'Zone 5 — CH 2000 to CH 2400', req(zones, 'South'), 2000, 2400);

  // -- WBS -----------------------------------------------------------------
  const wbs: Record<string, string> = {};
  const mkWbs = async (code: string, desc: string, parent: string | null, disc: string) => {
    const r = await one(
      `INSERT INTO wbs_element (project_id, parent_id, discipline_id, wbs_code, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, path`,
      [project.id, parent, req(disciplines, disc), code, desc],
    );
    wbs[code] = r.id;
    return r;
  };
  await mkWbs('3', 'Zone 3 works', null, 'CIV');
  await mkWbs('3.2', 'Zone 3 earthworks', req(wbs, '3'), 'CIV');
  await mkWbs('3.2.1', 'Zone 3 bulk earthworks', req(wbs, '3.2'), 'CIV');
  await mkWbs('3.2.1.4', 'Zone 3 select fill placement', req(wbs, '3.2.1'), 'CIV');
  await mkWbs('5', 'Zone 5 works', null, 'CIV');
  await mkWbs('5.1', 'Zone 5 drainage', req(wbs, '5'), 'DRN');

  // -- Work types ----------------------------------------------------------
  const workTypes: Record<string, string> = {};
  for (const [code, name, disc, geom, layered, rl, unit] of [
    ['EW', 'Bulk Earthworks', 'CIV', 'polygon', false, true, 'm3'],
    ['SF', 'Select Fill', 'CIV', 'polygon', true, true, 'm3'],
    ['SBC', 'Stabilised Base Course', 'PAV', 'polygon', true, true, 'm2'],
    ['AC', 'Asphalt Wearing Course', 'PAV', 'polygon', true, true, 'm2'],
    ['PIPE', 'Stormwater Pipeline', 'DRN', 'line', false, true, 'm'],
  ] as const) {
    const r = await one(
      `INSERT INTO work_type (project_id, discipline_id, code, name, geometry_kind,
                              is_layered, requires_rl, default_unit_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [project.id, req(disciplines, disc), code, name, geom, layered, rl, req(units, unit)],
    );
    workTypes[code] = r.id;
  }

  await c.query(
    `INSERT INTO lot_number_scheme (project_id, template, sequence_scope)
     VALUES ($1,'{zone}-{worktype}-{seq:4}','zone_worktype')`,
    [project.id],
  );
  await c.query(
    `INSERT INTO coordinate_system (project_id, srid, label, is_default_import)
     VALUES ($1, 7856, 'MGA2020 Zone 56', true)`,
    [project.id],
  );

  // -- Subcontract packages ------------------------------------------------
  const pkgs: Record<string, string> = {};
  for (const [key, org, code, scope] of [
    ['earth', req(orgs, 'subEarth'), 'P1-EARTH', 'Bulk earthworks and select fill, all zones'],
    ['drain', req(orgs, 'subDrain'), 'P2-DRAIN', 'Stormwater drainage, Zone 5'],
  ] as const) {
    const r = await one(
      `INSERT INTO subcontract_package (project_id, subcontractor_org_id, package_code, scope_description)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [project.id, org, code, scope],
    );
    pkgs[key] = r.id;
  }

  // -- Users ---------------------------------------------------------------
  const roleId = async (code: string) =>
    (await one(`SELECT id FROM role WHERE code=$1 AND owner_org_id IS NULL`, [code])).id;

  const users: Record<string, string> = {};
  const mkUser = async (
    key: string, email: string, name: string, org: string, pattern: string,
  ) => {
    const r = await one(
      `INSERT INTO user_account (email, full_name, status, primary_org_id, auth_pattern)
       VALUES ($1,$2,'active',$3,$4) RETURNING id`,
      [email, name, org, pattern],
    );
    users[key] = r.id;
    return r.id;
  };

  // Contractor staff on the home tenant.
  await mkUser('qm',      'p.nandakumar@northboundcivil.com.au', 'Priya Nandakumar', req(orgs, 'jvA'), 'home_tenant');
  await mkUser('em',      'd.whitcombe@northboundcivil.com.au',  'Dorothy Whitcombe', req(orgs, 'jvA'), 'home_tenant');
  await mkUser('peA',     'j.okafor@northboundcivil.com.au',     'Jarrah Okafor',     req(orgs, 'jvA'), 'home_tenant');
  await mkUser('cadetA',  'r.silvestri@northboundcivil.com.au',  'Rowan Silvestri',   req(orgs, 'jvA'), 'home_tenant');
  await mkUser('peB',     'm.tuiletufuga@kellerman.com.au',      'Mele Tuiletufuga',  req(orgs, 'jvB'), 'home_tenant');
  await mkUser('foreman', 'b.arkwright@kellerman.com.au',        'Bryn Arkwright',    req(orgs, 'jvB'), 'home_tenant');
  // Group Quality Manager: organisation-scoped (ADR-0023).
  await mkUser('gqm',     'a.delacroix@northboundcivil.com.au',  'Ash Delacroix',     req(orgs, 'jvA'), 'home_tenant');
  // Client and IV federate their own IdP rather than being guested.
  await mkUser('sr',      'k.ferreira@ardentsuper.com.au',       'Kwame Ferreira',    req(orgs, 'super'), 'federated_oidc');
  await mkUser('iv',      's.brenninkmeyer@meridianiv.com.au',   'Solveig Brenninkmeyer', req(orgs, 'iv'), 'federated_oidc');
  // Subcontractors and suppliers: local credentials + TOTP.
  await mkUser('subEarth','t.vellacott@vellacott.com.au',        'Tomas Vellacott',   req(orgs, 'subEarth'), 'local_credentials');
  await mkUser('subDrain','h.rowe@rowedrainage.com.au',          'Hana Rowe',         req(orgs, 'subDrain'), 'local_credentials');
  await mkUser('supplier','g.pantelis@hawkesburypremix.com.au',  'Georgia Pantelis',  req(orgs, 'supplier'), 'local_credentials');

  // Federated IdPs for the client and verifier organisations.
  for (const [org, issuer, domain] of [
    [req(orgs, 'super'), 'https://login.microsoftonline.com/ardent-super/v2.0', 'ardentsuper.com.au'],
    [req(orgs, 'iv'),    'https://idp.meridianiv.com.au/',                     'meridianiv.com.au'],
  ] as const) {
    await c.query(
      `INSERT INTO org_identity_provider (organisation_id, protocol, issuer, client_id,
                                          allowed_email_domains, status)
       VALUES ($1,'oidc',$2,'lotline',ARRAY[$3],'active')`,
      [org, issuer, domain],
    );
  }

  // -- Memberships ---------------------------------------------------------
  // The JV split: partner A's engineers write Zone 3 and WBS 3.2; partner B's
  // write Zone 5. Both read project-wide (ADR-0020).
  const mkMembership = async (
    user: string, role: string,
    readType = 'project', readId: string | null = null,
    writeType = 'project', writeId: string | null = null,
  ) => {
    await c.query(
      `INSERT INTO project_membership (project_id, user_id, role_id,
                                       read_scope_type, read_scope_id,
                                       write_scope_type, write_scope_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [project.id, req(users, user), await roleId(role), readType, readId, writeType, writeId],
    );
  };

  await mkMembership('qm', 'QM');
  await mkMembership('em', 'EM');
  await mkMembership('peA', 'PE', 'project', null, 'zone', req(zones, 'Z3'));
  await mkMembership('cadetA', 'CAD', 'project', null, 'zone', req(zones, 'Z3'));
  await mkMembership('peB', 'PE', 'project', null, 'zone', req(zones, 'Z5'));
  await mkMembership('foreman', 'FMN', 'project', null, 'zone', req(zones, 'Z5'));
  await mkMembership('sr', 'SR');
  await mkMembership('iv', 'IV', 'project', null, 'none', null);   // read + sign only
  await mkMembership('subEarth', 'SUB', 'package', req(pkgs, 'earth'), 'package', req(pkgs, 'earth'));
  await mkMembership('subDrain', 'SUB', 'package', req(pkgs, 'drain'), 'package', req(pkgs, 'drain'));
  await mkMembership('supplier', 'SUP', 'supplier_org', req(orgs, 'supplier'), 'supplier_org', req(orgs, 'supplier'));

  // Organisation-scoped: the Group QM fans out to every project Northbound
  // participates in, automatically.
  await c.query(
    `INSERT INTO org_membership (organisation_id, user_id, role_id, job_title)
     VALUES ($1,$2,$3,'Group Quality Manager')`,
    [req(orgs, 'jvA'), req(users, 'gqm'), await roleId('GQM')],
  );
  for (const [key, org, title] of [
    ['qm', req(orgs, 'jvA'), 'Quality Manager'],
    ['em', req(orgs, 'jvA'), 'Engineering Manager'],
    ['peA', req(orgs, 'jvA'), 'Section Engineer'],
    ['peB', req(orgs, 'jvB'), 'Section Engineer'],
  ] as const) {
    await c.query(
      `INSERT INTO org_membership (organisation_id, user_id, job_title) VALUES ($1,$2,$3)`,
      [org, req(users, key), title],
    );
  }

  // -- A trusted shared site tablet, with two users enrolled on it ----------
  const enrolEvent = await one(
    `INSERT INTO authentication_event (user_id, method, strength, mfa_satisfied, result)
     VALUES ($1,'idp_reauth','step_up',true,'success') RETURNING id`,
    [req(users, 'peA')],
  );
  const tablet = await one(
    `INSERT INTO device (project_id, label, platform, device_fingerprint, enrolment_status,
                         is_shared, bound_zone_id, enrolled_by, enrolment_auth_event_id, enrolled_at)
     VALUES ($1,'Zone 3 site office tablet 02','android','fp-z3-tablet-02','trusted',
             true,$2,$3,$4, now()) RETURNING id`,
    [project.id, req(zones, 'Z3'), req(users, 'peA'), enrolEvent.id],
  );
  for (const key of ['peA', 'cadetA'] as const) {
    const ev = await one(
      `INSERT INTO authentication_event (user_id, device_id, method, strength, mfa_satisfied, result)
       VALUES ($1,$2,'idp_primary','step_up',true,'success') RETURNING id`,
      [req(users, key), tablet.id],
    );
    await c.query(
      `INSERT INTO device_user_enrolment (device_id, user_id, credential_kind, pin_hash,
                                          enrolment_auth_event_id)
       VALUES ($1,$2,'pin','$argon2id$seeded-placeholder',$3)`,
      [tablet.id, req(users, key), ev.id],
    );
  }

  await c.query('COMMIT');

  const counts = await c.query(`
    SELECT 'access_grant' t, count(*)::int n FROM access_grant
    UNION ALL SELECT 'user_account', count(*)::int FROM user_account
    UNION ALL SELECT 'project_membership', count(*)::int FROM project_membership
    UNION ALL SELECT 'zone', count(*)::int FROM zone
    UNION ALL SELECT 'wbs_element', count(*)::int FROM wbs_element
    UNION ALL SELECT 'audit_log_entry', count(*)::int FROM audit_log_entry
    ORDER BY 1`);
  console.log('Seeded:');
  for (const r of counts.rows) console.log(`  ${r.t.padEnd(20)} ${r.n}`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
