/**
 * The §12.1 acceptance-criteria ITP: "Bulk Earthworks — Select Fill", twelve
 * checkpoints including two hold points and three witness points.
 *
 * Acceptance criteria text here is the CONTRACTOR'S OWN wording, and clause
 * references are placeholders written as `<spec> <clause>` pending the real
 * TfNSW register (ADR-0006, OQ-4). No published specification text appears, and
 * no real specification identifier is invented.
 */
import pg from 'pg';

export interface SeededItp {
  masterId: string;
  versionId: string;
  checkpointIds: string[];   // indexed by sequence_no - 1
}

interface CheckpointSpec {
  seq: number;
  activity: string;
  type: 'hold' | 'witness' | 'surveillance' | 'review' | 'record';
  party: 'contractor' | 'subcontractor' | 'client' | 'verifier' | 'laboratory' | 'surveyor';
  criteria: string;
  releaseRole?: string;
  noticeHours?: number;
  evidence?: { type: string; min?: number; mandatory?: boolean }[];
}

/**
 * Two hold points (5 and 9) and three witness points (3, 7, 11).
 *
 * The hold at 5 is client-nominated — proof-rolling of the subgrade is the
 * Superintendent's inspection — so only a client-side role can release it. The
 * hold at 9 is contractor-nominated.
 */
export const CHECKPOINTS: CheckpointSpec[] = [
  { seq: 1, activity: 'Confirm survey set-out of fill extent and design levels',
    type: 'record', party: 'surveyor',
    criteria: 'Set-out matches the issued-for-construction drawing revision recorded on the lot.',
    evidence: [{ type: 'survey' }] },
  { seq: 2, activity: 'Verify source material against approved material register',
    type: 'review', party: 'contractor',
    criteria: 'Material is on the project approved-materials register and within its validity period.',
    evidence: [{ type: 'test_certificate' }] },
  { seq: 3, activity: 'Inspection of stripped subgrade prior to fill placement',
    type: 'witness', party: 'client', noticeHours: 24,
    criteria: 'Subgrade stripped to design level, free of deleterious material and standing water.',
    evidence: [{ type: 'photo', min: 2 }] },
  { seq: 4, activity: 'Place and spread first layer to nominated loose thickness',
    type: 'surveillance', party: 'contractor',
    criteria: 'Loose layer thickness does not exceed the thickness nominated for the compaction plant in use.' },
  // HOLD 1 — client-nominated. Work cannot proceed past this until the
  // Superintendent's Representative releases it.
  { seq: 5, activity: 'Proof roll of prepared subgrade — HOLD POINT',
    type: 'hold', party: 'client', releaseRole: 'SR',
    criteria: 'No visible deflection, rutting or pumping under the nominated proof-rolling plant.',
    evidence: [{ type: 'photo', min: 2 }, { type: 'checklist' }] },
  { seq: 6, activity: 'Compact layer to specified density',
    type: 'surveillance', party: 'contractor',
    criteria: 'Compaction achieved by the plant and pass count in the approved method statement.' },
  { seq: 7, activity: 'Field density testing — witness',
    type: 'witness', party: 'client', noticeHours: 24,
    criteria: 'Test locations selected at the frequency in the ITP and not nominated by the placing crew.',
    evidence: [{ type: 'test_certificate', min: 3 }] },
  { seq: 8, activity: 'Review of laboratory density results against acceptance scheme',
    type: 'review', party: 'contractor',
    criteria: 'Characteristic value computed for the lot meets the target for the layer.',
    evidence: [{ type: 'test_certificate', min: 3 }] },
  // HOLD 2 — contractor-nominated.
  { seq: 9, activity: 'Engineering review of layer conformance before next layer — HOLD POINT',
    type: 'hold', party: 'contractor', releaseRole: 'EM',
    criteria: 'All density results conforming and no open non-conformance against this layer.',
    evidence: [{ type: 'checklist' }] },
  { seq: 10, activity: 'Survey conformance of finished layer levels',
    type: 'record', party: 'surveyor',
    criteria: 'Finished levels within the vertical tolerance recorded on the lot, against the named datum.',
    evidence: [{ type: 'survey' }] },
  { seq: 11, activity: 'Final joint inspection of completed lot',
    type: 'witness', party: 'client', noticeHours: 48,
    criteria: 'Completed surface free of defects, correctly drained, and ready for the overlying layer.',
    evidence: [{ type: 'photo', min: 4 }] },
  { seq: 12, activity: 'Compile lot conformance record',
    type: 'record', party: 'contractor',
    criteria: 'Every checkpoint signed, all required evidence attached, no open non-conformance.',
    evidence: [{ type: 'checklist' }] },
];

export async function seedItp(c: pg.Client, projectId: string): Promise<SeededItp> {
  const workTypeId = (await c.query(
    `SELECT id FROM work_type WHERE project_id = $1 AND code = 'SF'`, [projectId])).rows[0].id;

  const masterId = (await c.query(
    `INSERT INTO itp_master (owner_org_id, project_id, code, title, work_type_id)
     VALUES ((SELECT id FROM organisation WHERE legal_name='Northbound Civil Pty Ltd'),
             $1,'ITP-EW-SF','Bulk Earthworks — Select Fill',$2)
     RETURNING id`, [projectId, workTypeId])).rows[0].id;

  const versionId = (await c.query(
    `INSERT INTO itp_master_version (itp_master_id, version_no, status) VALUES ($1,1,'draft')
     RETURNING id`, [masterId])).rows[0].id;

  const roleId = async (code: string) =>
    (await c.query(`SELECT id FROM role WHERE code=$1 AND owner_org_id IS NULL`, [code])).rows[0].id;

  const checkpointIds: string[] = [];
  for (const cp of CHECKPOINTS) {
    const id = (await c.query(
      `INSERT INTO itp_master_checkpoint
         (itp_master_version_id, sequence_no, activity, checkpoint_type, responsible_party,
          release_role_id, acceptance_criteria, notice_hours, blocking_scope, frequency_basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'per_lot') RETURNING id`,
      [versionId, cp.seq, cp.activity, cp.type, cp.party,
       cp.releaseRole ? await roleId(cp.releaseRole) : null,
       cp.criteria, cp.noticeHours ?? null,
       // Only a hold may block; the CHECK constraint enforces it either way.
       cp.type === 'hold' ? 'all_subsequent' : 'none'],
    )).rows[0].id;
    checkpointIds.push(id);

    for (const ev of cp.evidence ?? []) {
      await c.query(
        `INSERT INTO itp_master_evidence_req
           (itp_master_checkpoint_id, evidence_type, min_count, mandatory)
         VALUES ($1,$2,$3,$4)`,
        [id, ev.type, ev.min ?? 1, ev.mandatory ?? true]);
    }
  }

  // Publish, pinning the content hash the instance will carry.
  await c.query(
    `UPDATE itp_master_version
        SET status='published', published_at=now(),
            published_by=(SELECT id FROM user_account WHERE email='p.nandakumar@northboundcivil.com.au'),
            content_hash = public.itp_version_content_hash($1)
      WHERE id = $1`, [versionId]);

  return { masterId, versionId, checkpointIds };
}

/** A lot to hang the instance on. No geometry — see migration 0026. */
export async function seedLot(
  c: pg.Client, projectId: string, versionId: string,
): Promise<{ lotId: string; instanceId: string }> {
  const zone = (await c.query(`SELECT id FROM zone WHERE project_id=$1 AND code='Z3'`, [projectId])).rows[0].id;
  const wbs  = (await c.query(`SELECT id FROM wbs_element WHERE project_id=$1 AND wbs_code='3.2.1.4'`, [projectId])).rows[0].id;
  const wt   = (await c.query(`SELECT id FROM work_type WHERE project_id=$1 AND code='SF'`, [projectId])).rows[0].id;
  const unit = (await c.query(`SELECT id FROM unit WHERE code='m3'`)).rows[0].id;
  const eng  = (await c.query(`SELECT id FROM user_account WHERE email='j.okafor@northboundcivil.com.au'`)).rows[0].id;

  const lotId = (await c.query(
    `INSERT INTO lot (project_id, zone_id, wbs_element_id, work_type_id, lot_number,
                      status, quantity, unit_id, responsible_engineer_id, raised_on)
     VALUES ($1,$2,$3,$4,'Z3-EW-0142','Open',480,$5,$6,CURRENT_DATE) RETURNING id`,
    [projectId, zone, wbs, wt, unit, eng])).rows[0].id;

  const instanceId = (await c.query(
    `SELECT public.snapshot_itp($1,$2) AS id`, [lotId, versionId])).rows[0].id;

  return { lotId, instanceId };
}
