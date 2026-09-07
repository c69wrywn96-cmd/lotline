/**
 * ADR-0013: the audit log is written by trigger, from session GUCs, so it cannot
 * be forgotten or bypassed by any application code path.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb, userId, USERS } from './helpers';
import { randomUUID } from 'node:crypto';

afterAll(async () => { await appDb.end(); });

describe('audit trigger', () => {
  it('records every mutation with before and after values and the full request context', async () => {
    const uid = await userId(USERS.qm);
    const requestId = randomUUID();
    const authEventId = await asOwner(async (c) =>
      (
        await c.query(
          `INSERT INTO authentication_event (user_id, method, strength, mfa_satisfied, result)
           VALUES ($1,'idp_reauth','step_up',true,'success') RETURNING id`,
          [uid],
        )
      ).rows[0].id,
    );

    await appDb.withSession(
      {
        userId: uid,
        requestId,
        ip: '203.0.113.44',
        userAgent: 'Lotline/1.0 (test)',
        authEventId,
      },
      async (db) => {
        await db.query(
          `UPDATE work_type SET name = 'Bulk Earthworks (revised)' WHERE code = 'EW'`,
        );
      },
    );

    const entry = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT * FROM audit_log_entry
            WHERE request_id = $1 AND subject_type = 'work_type' AND action = 'update'`,
          [requestId],
        )
      ).rows[0],
    );

    expect(entry, 'the update must be audited').toBeDefined();
    expect(entry.actor_user_id).toBe(uid);
    expect(entry.ip_address).toBe('203.0.113.44');
    expect(entry.user_agent).toBe('Lotline/1.0 (test)');
    expect(entry.auth_event_id).toBe(authEventId);
    expect(entry.before_value.name).toBe('Bulk Earthworks');
    expect(entry.after_value.name).toBe('Bulk Earthworks (revised)');
    expect(entry.project_id).not.toBeNull();
  });

  it('attributes the actor even when the write happens through a trigger cascade', async () => {
    const uid = await userId(USERS.qm);
    const requestId = randomUUID();

    // Renaming a parent zone rewrites every descendant's ltree path via the
    // cascade trigger. Those cascaded writes must still be attributed.
    await appDb.withSession({ userId: uid, requestId }, async (db) => {
      await db.query(`UPDATE zone SET code = 'Nth' WHERE code = 'North'`);
    });

    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT subject_type, actor_user_id FROM audit_log_entry WHERE request_id = $1`,
          [requestId],
        )
      ).rows,
    );
    expect(rows.length).toBeGreaterThan(1); // parent + cascaded children
    for (const r of rows) expect(r.actor_user_id).toBe(uid);

    await asOwner(async (c) => { await c.query(`UPDATE zone SET code='North' WHERE code='Nth'`); });
  });

  it('is append-only: the application cannot update or delete log entries', async () => {
    const uid = await userId(USERS.qm);
    await expect(
      appDb.withSession({ userId: uid }, async (db) =>
        db.query(`UPDATE audit_log_entry SET after_value = '{}'::jsonb WHERE true`),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      appDb.withSession({ userId: uid }, async (db) =>
        db.query(`DELETE FROM audit_log_entry WHERE true`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is partitioned by month, so retention is detach rather than delete', async () => {
    const parts = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT count(*)::int n FROM pg_inherits i
             JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = 'audit_log_entry'`,
        )
      ).rows[0].n,
    );
    expect(parts).toBeGreaterThanOrEqual(3);
  });

  it('membership changes are audited — this is the permission_change trail', async () => {
    const before = await asOwner(async (c) =>
      (await c.query(`SELECT count(*)::int n FROM audit_log_entry WHERE subject_type='project_membership'`)).rows[0].n,
    );
    expect(before).toBeGreaterThan(0);
  });
});
