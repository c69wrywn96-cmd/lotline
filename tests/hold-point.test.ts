/**
 * The eleven hold-point assertions — 02-state-machines.md §4.5, and acceptance
 * criterion §12.4.
 *
 * All at SQL level, run as `lotline_app` with RLS in force. No application
 * process participates: the block is a database constraint, and the proof has to
 * be reachable from psql or it is not a proof.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { asOwner, appDb, userId, USERS } from './helpers';
import { recordAuthenticationEvent } from '../src/auth/session-bridge';
import type { SessionContext } from '../src/db/session';
import { randomUUID, createHash } from 'node:crypto';

afterAll(async () => { await appDb.end(); });

const LOT = 'Z3-EW-0142';

async function ctxFor(email: string, strength: 'device_unlock' | 'step_up' = 'device_unlock'): Promise<SessionContext> {
  const uid = await userId(email);
  const authEventId = await asOwner((c) => recordAuthenticationEvent(c, {
    userId: uid, method: strength === 'step_up' ? 'idp_reauth' : 'idp_primary', mfaSatisfied: true,
  }));
  return { userId: uid, authEventId, requestId: randomUUID(), authStrength: strength, deviceBound: false };
}

const run = <T>(ctx: SessionContext, fn: (db: any) => Promise<T>) => appDb.withSession(ctx, fn);

/** Checkpoint ids by sequence number, for the seeded lot. */
async function checkpoints(): Promise<Record<number, string>> {
  const rows = await asOwner(async (c) =>
    (await c.query(
      `SELECT c.sequence_no, c.id FROM itp_checkpoint c
         JOIN itp_instance i ON i.id = c.itp_instance_id
         JOIN lot l ON l.id = i.lot_id
        WHERE l.lot_number = $1 AND c.superseded_by_id IS NULL
        ORDER BY c.sequence_no`, [LOT])).rows);
  return Object.fromEntries(rows.map((r) => [r.sequence_no, r.id]));
}

const projectId = () => asOwner(async (c) =>
  (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id as string);

/** Attempts to advance a checkpoint, as an application user. */
async function action(
  cpId: string, email = USERS.peA, state = 'in_progress',
): Promise<{ rowCount: number | null }> {
  const ctx = await ctxFor(email);
  return run(ctx, (db) =>
    db.query(`UPDATE itp_checkpoint SET state = $2 WHERE id = $1`, [cpId, state]));
}

/** Signs and releases a hold point, the normal way. */
async function releaseHold(
  cpId: string, email: string, kind: 'standard' | 'concession' | 'retrospective' = 'standard',
  extra: { concessionId?: string; retrospectiveId?: string } = {},
): Promise<void> {
  const uid = await userId(email);
  const project = await projectId();
  await asOwner(async (c) => {
    const ev = await recordAuthenticationEvent(c, {
      userId: uid, method: 'idp_reauth', mfaSatisfied: true,
    });
    const sig = (await c.query(
      `INSERT INTO signature (project_id, user_id, purpose, subject_type, subject_id,
                              subject_hash, signature_method, auth_strength,
                              authentication_event_id)
       VALUES ($1,$2,'hold_release','itp_checkpoint',$3,$4,'idp_reauth','step_up',$5)
       RETURNING id`,
      [project, uid, cpId, createHash('sha256').update(cpId).digest('hex'), ev])).rows[0].id;
    await c.query(
      `INSERT INTO hold_release (project_id, itp_checkpoint_id, release_kind, released_by,
                                 signature_id, concession_id, retrospective_release_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [project, cpId, kind, uid, sig, extra.concessionId ?? null, extra.retrospectiveId ?? null]);
  });
}

/** Returns the seeded lot's ITP to a clean, unreleased state between tests. */
beforeEach(async () => {
  await asOwner(async (c) => {
    const lotFilter = `itp_instance_id IN (
      SELECT i.id FROM itp_instance i JOIN lot l ON l.id=i.lot_id WHERE l.lot_number=$1)`;

    // Fully idempotent, so a test that throws before its own cleanup cannot
    // poison the ones after it. Order is load-bearing throughout.
    await c.query(`DELETE FROM checkpoint_evidence WHERE itp_checkpoint_id IN
                     (SELECT id FROM itp_checkpoint WHERE ${lotFilter})`, [LOT]);
    await c.query(`DELETE FROM signature_withdrawal WHERE checkpoint_correction_id IN
                     (SELECT id FROM checkpoint_correction WHERE itp_checkpoint_id IN
                        (SELECT id FROM itp_checkpoint WHERE ${lotFilter}))`, [LOT]);
    await c.query(`DELETE FROM checkpoint_correction WHERE itp_checkpoint_id IN
                     (SELECT id FROM itp_checkpoint WHERE ${lotFilter})`, [LOT]);
    // Three steps, in this order: drop the pointer, delete the replacement, then
    // bring the original back. Deleting first breaks the superseded_by_id
    // foreign key; restoring first puts two rows on one sequence and the
    // live-sequence index rejects it.
    await c.query(`UPDATE itp_checkpoint SET superseded_by_id=NULL
                    WHERE ${lotFilter} AND superseded_by_id IS NOT NULL`, [LOT]);
    await c.query(`DELETE FROM itp_checkpoint
                    WHERE ${lotFilter} AND corrected_from_id IS NOT NULL`, [LOT]);
    await c.query(`UPDATE itp_checkpoint SET superseded_at=NULL
                    WHERE ${lotFilter} AND superseded_at IS NOT NULL`, [LOT]);
    // States are rewound WHILE the clearance records still exist; deleting the
    // releases first would re-block the instance and the rewind would raise
    // LOTLINE_HOLD_POINT_BLOCKED — the trigger behaving correctly, not a test
    // to work around.
    await c.query(`UPDATE itp_checkpoint SET state='pending'
                    WHERE ${lotFilter} AND state <> 'pending'`, [LOT]);
    await c.query(`DELETE FROM hold_release WHERE itp_checkpoint_id IN
                     (SELECT id FROM itp_checkpoint WHERE ${lotFilter})`, [LOT]);
    await c.query(`DELETE FROM retrospective_release_outcome WHERE retrospective_release_id IN
                     (SELECT r.id FROM retrospective_release r
                       WHERE r.itp_checkpoint_id IN
                         (SELECT id FROM itp_checkpoint WHERE ${lotFilter}))`, [LOT]);
    await c.query(`DELETE FROM retrospective_verification_evidence
                    WHERE retrospective_release_id IN
                     (SELECT r.id FROM retrospective_release r
                       WHERE r.itp_checkpoint_id IN
                         (SELECT id FROM itp_checkpoint WHERE ${lotFilter}))`, [LOT]);
    await c.query(`DELETE FROM retrospective_release WHERE itp_checkpoint_id IN
                     (SELECT id FROM itp_checkpoint WHERE ${lotFilter})`, [LOT]);
  });
});

describe('the ITP instance is a snapshot, not a pointer (ADR-0008)', () => {
  it('carries the published version content hash', async () => {
    const row = await asOwner(async (c) =>
      (await c.query(
        `SELECT i.content_hash, v.content_hash AS version_hash, v.status
           FROM itp_instance i
           JOIN itp_master_version v ON v.id = i.itp_master_version_id
           JOIN lot l ON l.id = i.lot_id WHERE l.lot_number = $1`, [LOT])).rows[0]);
    expect(row.status).toBe('published');
    expect(row.content_hash).toBe(row.version_hash);
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a lot cannot be raised against an unpublished version', async () => {
    await expect(
      asOwner(async (c) => {
        const draft = (await c.query(
          `INSERT INTO itp_master_version (itp_master_id, version_no, status)
           SELECT id, 99, 'draft' FROM itp_master WHERE code='ITP-EW-SF' RETURNING id`)).rows[0].id;
        const lot = (await c.query(
          `SELECT id FROM lot WHERE lot_number=$1`, [LOT])).rows[0].id;
        return c.query(`SELECT public.snapshot_itp($1,$2)`, [lot, draft]);
      }),
    ).rejects.toThrow(/LOTLINE_ITP_NOT_PUBLISHED/);
  });

  it('editing the master afterwards does not reach the instance', async () => {
    const before = await asOwner(async (c) =>
      (await c.query(
        `SELECT c.activity FROM itp_checkpoint c
           JOIN itp_instance i ON i.id=c.itp_instance_id
           JOIN lot l ON l.id=i.lot_id
          WHERE l.lot_number=$1 AND c.sequence_no=5 AND c.superseded_by_id IS NULL`,
        [LOT])).rows[0].activity);

    await asOwner(async (c) => {
      await c.query(
        `UPDATE itp_master_checkpoint SET activity = 'REWRITTEN AFTER THE FACT'
          WHERE sequence_no = 5 AND itp_master_version_id =
                (SELECT itp_master_version_id FROM itp_instance i
                   JOIN lot l ON l.id=i.lot_id WHERE l.lot_number=$1)`, [LOT]);
    });

    const after = await asOwner(async (c) =>
      (await c.query(
        `SELECT c.activity FROM itp_checkpoint c
           JOIN itp_instance i ON i.id=c.itp_instance_id
           JOIN lot l ON l.id=i.lot_id
          WHERE l.lot_number=$1 AND c.sequence_no=5 AND c.superseded_by_id IS NULL`,
        [LOT])).rows[0].activity);
    expect(after).toBe(before);
    expect(after).not.toContain('REWRITTEN');
  });
});

describe('§4.5 — the eleven assertions', () => {
  it('T1: with cp5 (hold) unreleased, actioning cp6 is blocked', async () => {
    const cp = await checkpoints();
    await expect(action(cp[6]!)).rejects.toThrow(/LOTLINE_HOLD_POINT_BLOCKED/);
  });

  it('T2: with cp5 unreleased, attaching evidence to cp6 raises the same', async () => {
    const cp = await checkpoints();
    const ctx = await ctxFor(USERS.peA);
    const project = await projectId();
    await expect(
      run(ctx, (db) => db.query(
        `INSERT INTO checkpoint_evidence (project_id, itp_checkpoint_id, subject_type, subject_id)
         VALUES ($1,$2,'photo',$3)`, [project, cp[6], randomUUID()])),
    ).rejects.toThrow(/LOTLINE_HOLD_POINT_BLOCKED/);
  });

  it('T3: after a standard release of cp5 by the nominated party, cp6 proceeds', async () => {
    const cp = await checkpoints();
    // cp5 is CLIENT-nominated: the Superintendent's Representative releases it.
    await releaseHold(cp[5]!, USERS.sr);
    const res = await action(cp[6]!);
    expect(res.rowCount).toBe(1);
  });

  it('T4: a WITNESS point does not block, in any state', async () => {
    // cp3 is a witness point at a lower sequence than cp4. Work proceeds once
    // the notice period elapses, whether or not the client attends.
    const cp = await checkpoints();
    for (const state of ['pending', 'notified', 'in_progress']) {
      await asOwner(async (c) => {
        await c.query(`UPDATE itp_checkpoint SET state=$2 WHERE id=$1`, [cp[3], state]);
      });
      const res = await action(cp[4]!);
      expect(res.rowCount, `witness in state ${state} must not block`).toBe(1);
      await asOwner(async (c) => {
        await c.query(`UPDATE itp_checkpoint SET state='pending' WHERE id=$1`, [cp[4]]);
      });
    }
  });

  it('T5: a witness checkpoint cannot be given a blocking scope, at either level', async () => {
    await expect(
      asOwner(async (c) => c.query(
        `UPDATE itp_master_checkpoint SET blocking_scope='all_subsequent'
          WHERE checkpoint_type='witness'`)),
    ).rejects.toThrow(/only_holds_block/);

    const cp = await checkpoints();
    await expect(
      asOwner(async (c) => c.query(
        `UPDATE itp_checkpoint SET blocking_scope='all_subsequent' WHERE id=$1`, [cp[3]])),
    ).rejects.toThrow(/only_holds_block/);
  });

  it('T6: a concession release clears the block, and the concession is on the record', async () => {
    const cp = await checkpoints();
    const project = await projectId();
    const concessionId = await asOwner(async (c) => {
      const em = (await c.query(
        `SELECT id FROM user_account WHERE email='d.whitcombe@northboundcivil.com.au'`)).rows[0].id;
      const ev = await recordAuthenticationEvent(c, {
        userId: em, method: 'idp_reauth', mfaSatisfied: true });
      const sig = (await c.query(
        `INSERT INTO signature (project_id, user_id, purpose, subject_type, subject_id,
                                subject_hash, signature_method, auth_strength, authentication_event_id)
         VALUES ($1,$2,'concession_em','itp_checkpoint',$3,'h','idp_reauth','step_up',$4)
         RETURNING id`, [project, em, cp[5], ev])).rows[0].id;
      return (await c.query(
        `INSERT INTO concession (project_id, subject_type, subject_id, reason, requested_by,
                                 engineering_manager_signature_id, status)
         VALUES ($1,'itp_checkpoint',$2,'Proof roll not witnessed; accepted on survey evidence',
                 $3,$4,'em_approved') RETURNING id`,
        [project, cp[5], em, sig])).rows[0].id;
    });

    await releaseHold(cp[5]!, USERS.sr, 'concession', { concessionId });
    expect((await action(cp[6]!)).rowCount).toBe(1);

    const kind = await asOwner(async (c) =>
      (await c.query(
        `SELECT release_kind, concession_id FROM hold_release WHERE itp_checkpoint_id=$1`,
        [cp[5]])).rows[0]);
    expect(kind.release_kind).toBe('concession');
    expect(kind.concession_id).toBe(concessionId);
  });

  it('T7: a retrospective release clears the block and classifies the lapse', async () => {
    const cp = await checkpoints();
    const project = await projectId();
    const sr = await userId(USERS.sr);

    const retroId = await asOwner(async (c) =>
      (await c.query(
        `INSERT INTO retrospective_release
           (project_id, itp_checkpoint_id, work_proceeded_at, release_decision_at,
            discovery_method, verification_basis, decision_evidence_kind,
            justification, recorded_by)
         VALUES ($1,$2, now() - interval '2 days', now() - interval '1 day',
                 'internal_audit','contemporaneous_evidence','none',
                 'Proof roll went ahead before the release was signed.', $3)
         RETURNING id`, [project, cp[5], sr])).rows[0].id);

    await releaseHold(cp[5]!, USERS.sr, 'retrospective', { retrospectiveId: retroId });
    expect((await action(cp[6]!)).rowCount).toBe(1);

    // The decision came AFTER the work, so this is unreleased progression and
    // an NCR is required (ADR-0019).
    const outcome = await asOwner(async (c) =>
      (await c.query(
        `SELECT lag_class, ncr_required, proposed_severity FROM retrospective_release_outcome
          WHERE retrospective_release_id=$1`, [retroId])).rows[0]);
    expect(outcome.lag_class).toBe('unreleased_progression');
    expect(outcome.ncr_required).toBe(true);
    expect(outcome.proposed_severity).toBe('minor');
  });

  it('T8: a retrospective release by someone not nominated, or on the wrong side, is refused', async () => {
    const cp = await checkpoints();
    const project = await projectId();
    const sr = await userId(USERS.sr);
    const retroId = await asOwner(async (c) =>
      (await c.query(
        `INSERT INTO retrospective_release
           (project_id, itp_checkpoint_id, work_proceeded_at, release_decision_at,
            discovery_method, verification_basis, justification, recorded_by)
         VALUES ($1,$2, now() - interval '2 days', now() - interval '1 day',
                 'self_identified','physical_reinspection','late', $3) RETURNING id`,
        [project, cp[5], sr])).rows[0].id);

    // cp5 is client-nominated; the Engineering Manager is on the contractor side.
    await expect(
      releaseHold(cp[5]!, USERS.em, 'retrospective', { retrospectiveId: retroId }),
    ).rejects.toThrow(/LOTLINE_RELEASE_NOT_NOMINATED/);
  });

  it('T9: correcting a released hold RE-BLOCKS everything after it', async () => {
    const cp = await checkpoints();
    await releaseHold(cp[5]!, USERS.sr);
    expect((await action(cp[6]!)).rowCount).toBe(1);

    // Rewind cp6 BEFORE the correction: once cp5's replacement exists there is
    // no clearance, and even winding cp6 back is progression past a live hold.
    await asOwner(async (c) => {
      await c.query(`UPDATE itp_checkpoint SET state='pending' WHERE id=$1`, [cp[6]]);
    });

    const ctx = await ctxFor(USERS.qm, 'step_up');
    const newId = await run(ctx, async (db) =>
      (await db.query(
        `SELECT public.correct_checkpoint($1,'wrong_signatory','Released by the wrong delegate') AS id`,
        [cp[5]])).rows[0].id);
    expect(newId).toBeTruthy();

    // The replacement carries no clearance record, so the block is back. A
    // correction cannot be used to launder a hold point.
    await expect(action(cp[6]!)).rejects.toThrow(/LOTLINE_HOLD_POINT_BLOCKED/);

    // The original checkpoint, its signature and the withdrawal all remain.
    const withdrawal = await asOwner(async (c) =>
      (await c.query(
        `SELECT w.reason, s.id AS signature_id FROM signature_withdrawal w
           JOIN signature s ON s.id = w.signature_id
          WHERE s.subject_id = $1`, [cp[5]])).rows[0]);
    expect(withdrawal.reason).toContain('wrong delegate');
    expect(withdrawal.signature_id).toBeTruthy();

    const original = await asOwner(async (c) =>
      (await c.query(
        `SELECT superseded_at IS NOT NULL AS stepped_aside, superseded_by_id
           FROM itp_checkpoint WHERE id=$1`, [cp[5]])).rows[0]);
    expect(original.stepped_aside).toBe(true);
    expect(original.superseded_by_id).toBe(newId);
  });

  it('T10: a hold_release without a signature does not clear the block', async () => {
    const cp = await checkpoints();
    const project = await projectId();
    const sr = await userId(USERS.sr);
    // The column is NOT NULL, so an unsigned clearance cannot even be written.
    await expect(
      asOwner(async (c) => c.query(
        `INSERT INTO hold_release (project_id, itp_checkpoint_id, release_kind,
                                   released_by, signature_id)
         VALUES ($1,$2,'standard',$3,NULL)`, [project, cp[5], sr])),
      // The trigger reaches it before the NOT NULL constraint does, and says
      // something more useful than a column name.
    ).rejects.toThrow(/LOTLINE_RELEASE_UNSIGNED|null value in column "signature_id"/i);

    expect(await asOwner(async (c) =>
      (await c.query(`SELECT public.itp_checkpoint_cleared($1) AS c`, [cp[5]])).rows[0].c))
      .toBe(false);
  });

  it('T11: waived is unreachable for a hold checkpoint', async () => {
    const cp = await checkpoints();
    await expect(
      asOwner(async (c) => c.query(
        `UPDATE itp_checkpoint SET state='waived' WHERE id=$1`, [cp[5]])),
    ).rejects.toThrow(/waived_is_witness_only/);
  });
});

describe('the release authority rules', () => {
  it('a contractor cannot release a client-nominated hold point', async () => {
    const cp = await checkpoints();
    await expect(releaseHold(cp[5]!, USERS.em)).rejects.toThrow(/LOTLINE_RELEASE_NOT_NOMINATED/);
  });

  it('the client cannot release a contractor-nominated hold point', async () => {
    const cp = await checkpoints();
    // cp9 is nominated to the Engineering Manager.
    await expect(releaseHold(cp[9]!, USERS.sr)).rejects.toThrow(/LOTLINE_RELEASE_NOT_NOMINATED/);
  });

  it('the nominated Engineering Manager can release cp9', async () => {
    const cp = await checkpoints();
    await releaseHold(cp[5]!, USERS.sr);
    await releaseHold(cp[9]!, USERS.em);
    expect((await action(cp[10]!)).rowCount).toBe(1);
  });

  it('a release signed at less than step-up strength is refused', async () => {
    const cp = await checkpoints();
    const project = await projectId();
    const sr = await userId(USERS.sr);
    await expect(
      asOwner(async (c) => {
        const ev = await recordAuthenticationEvent(c, {
          userId: sr, method: 'device_pin', mfaSatisfied: true });
        const sig = (await c.query(
          `INSERT INTO signature (project_id, user_id, purpose, subject_type, subject_id,
                                  subject_hash, signature_method, auth_strength, authentication_event_id)
           VALUES ($1,$2,'hold_release','itp_checkpoint',$3,'h','device_pin','device_unlock',$4)
           RETURNING id`, [project, sr, cp[5], ev])).rows[0].id;
        return c.query(
          `INSERT INTO hold_release (project_id, itp_checkpoint_id, release_kind, released_by, signature_id)
           VALUES ($1,$2,'standard',$3,$4)`, [project, cp[5], sr, sig]);
      }),
    ).rejects.toThrow(/LOTLINE_RELEASE_STEP_UP_REQUIRED/);
  });
});

describe('ADR-0019 — the administrative lag branch cannot be self-asserted', () => {
  const insertRetro = (fields: string, values: unknown[]) =>
    asOwner(async (c) => {
      const project = await projectId();
      const cp = await checkpoints();
      const sr = await userId(USERS.sr);
      return (await c.query(
        `INSERT INTO retrospective_release
           (project_id, itp_checkpoint_id, work_proceeded_at, release_decision_at,
            discovery_method, verification_basis, justification, recorded_by ${fields})
         VALUES ($1,$2, now() - interval '2 days', now() - interval '3 days',
                 'self_identified','contemporaneous_evidence','verbal release at the excavation', $3
                 ${values.map((_, i) => `,$${i + 4}`).join('')})
         RETURNING lag_class`,
        [project, cp[5], sr, ...values])).rows[0].lag_class;
    });

  it('a decision made before the work, WITH evidence, is an administrative lag and raises no NCR', async () => {
    const lagClass = await insertRetro(
      ', decision_evidence_kind, decision_witness_name', ['diary_entry', 'Superintendent on site']);
    expect(lagClass).toBe('administrative_lag');

    const outcome = await asOwner(async (c) =>
      (await c.query(
        `SELECT ncr_required, rationale FROM retrospective_release_outcome
          ORDER BY determined_at DESC LIMIT 1`)).rows[0]);
    expect(outcome.ncr_required).toBe(false);
    expect(outcome.rationale).toContain('only the signature was late');
  });

  it('the same claim with NOTHING behind it degrades to unreleased progression', async () => {
    // Claiming a lag without a witness or contemporaneous record does not fail —
    // it silently stops being a lag, and the NCR is raised.
    const lagClass = await insertRetro(', decision_evidence_kind', ['none']);
    expect(lagClass).toBe('unreleased_progression');

    const outcome = await asOwner(async (c) =>
      (await c.query(
        `SELECT ncr_required FROM retrospective_release_outcome
          ORDER BY determined_at DESC LIMIT 1`)).rows[0]);
    expect(outcome.ncr_required).toBe(true);
  });

  it('the classification is a generated column, so there is nothing to override', async () => {
    await expect(
      asOwner(async (c) => c.query(
        `UPDATE retrospective_release SET lag_class = 'administrative_lag'`)),
    ).rejects.toThrow(/can only be updated to DEFAULT|generated/i);
  });

  it('no verification basis at all is major, and expensive to record', async () => {
    const project = await projectId();
    const cp = await checkpoints();
    const sr = await userId(USERS.sr);
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO retrospective_release
           (project_id, itp_checkpoint_id, work_proceeded_at, release_decision_at,
            discovery_method, verification_basis, justification, recorded_by)
         VALUES ($1,$2, now() - interval '5 days', now() - interval '1 day',
                 'client_surveillance','none','Nobody recorded the state of the subgrade.', $3)`,
        [project, cp[5], sr]);
    });
    const outcome = await asOwner(async (c) =>
      (await c.query(
        `SELECT proposed_severity, rationale FROM retrospective_release_outcome
          ORDER BY determined_at DESC LIMIT 1`)).rows[0]);
    expect(outcome.proposed_severity).toBe('major');
    expect(outcome.rationale).toContain('should be expensive');
  });
});
