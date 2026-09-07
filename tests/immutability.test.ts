/**
 * ADR-0003: there is no delete in this product, and a signed record is frozen.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { as, asOwner, appDb, userId, USERS } from './helpers.js';

afterAll(async () => { await appDb.end(); });

describe('DELETE is revoked, everywhere', () => {
  it('no application role holds DELETE on any table in public', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT table_name, grantee FROM information_schema.role_table_grants
            WHERE table_schema='public' AND privilege_type IN ('DELETE','TRUNCATE')
              AND grantee IN ('lotline_app','lotline_worker','lotline_readonly')
            ORDER BY table_name`,
        )
      ).rows,
    );
    expect(rows).toEqual([]);
  });

  it('a DELETE attempt fails at the database, not in application code', async () => {
    const uid = await userId(USERS.qm);
    await expect(
      appDb.withSession({ userId: uid }, async (db) =>
        db.query(`DELETE FROM zone WHERE code = 'Z3'`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('DELETE is refused even on tables a user can otherwise write', async () => {
    const uid = await userId(USERS.qm);
    for (const table of ['project', 'work_type', 'wbs_element', 'discipline']) {
      await expect(
        appDb.withSession({ userId: uid }, async (db) => db.query(`DELETE FROM ${table}`)),
        `${table} must refuse DELETE`,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('future tables inherit the revocation through default privileges', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT defaclacl::text acl FROM pg_default_acl d
             JOIN pg_namespace n ON n.oid = d.defaclnamespace
            WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'`,
        )
      ).rows,
    );
    const acl = rows.map((r) => r.acl).join(' ');
    // 'd' is the DELETE privilege letter; it must not appear for any lotline role.
    for (const role of ['lotline_app', 'lotline_worker', 'lotline_readonly']) {
      const grant = new RegExp(`${role}=([a-zA-Z]*)`).exec(acl)?.[1] ?? '';
      expect(grant, `${role} default privileges must not include DELETE`).not.toContain('d');
    }
  });
});

describe('the lock trigger', () => {
  it('freezes a locked row except for its enumerated unfrozen columns', async () => {
    await asOwner(async (c) => {
      await c.query(`
        CREATE TABLE IF NOT EXISTS lock_probe (
          id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
          project_id uuid,
          payload text,
          client_accepted_at timestamptz,
          locked_at timestamptz,
          superseded_by_id uuid,
          superseded_at timestamptz,
          supersede_reason text,
          updated_at timestamptz,
          updated_by uuid
        )`);
      await c.query(`DROP TRIGGER IF EXISTS lock_probe_locked ON lock_probe`);
      await c.query(`CREATE TRIGGER lock_probe_locked BEFORE UPDATE ON lock_probe
                       FOR EACH ROW EXECUTE FUNCTION public.assert_not_locked()`);
      await c.query(`DELETE FROM lock_probe`);
      await c.query(`INSERT INTO lock_probe (payload, locked_at) VALUES ('signed', now())`);
    });

    // A frozen column is refused.
    await expect(
      asOwner(async (c) => c.query(`UPDATE lock_probe SET payload = 'tampered'`)),
    ).rejects.toThrow(/LOTLINE_RECORD_LOCKED/);

    // Supersession is always permitted — it is the only correction mechanism.
    await asOwner(async (c) => {
      await c.query(
        `UPDATE lock_probe SET superseded_at = now(), supersede_reason = 'corrected'`,
      );
    });

    // G19: client acceptance lands on an already-locked, already-conformed lot.
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO unfrozen_column (table_name, column_name, reason)
         VALUES ('lock_probe','client_accepted_at','ADR-0022 G19')
         ON CONFLICT DO NOTHING`,
      );
      await c.query(`UPDATE lock_probe SET client_accepted_at = now()`);
    });

    const row = await asOwner(async (c) =>
      (await c.query(`SELECT payload, client_accepted_at FROM lock_probe`)).rows[0],
    );
    expect(row.payload).toBe('signed');
    expect(row.client_accepted_at).not.toBeNull();

    await asOwner(async (c) => {
      await c.query(`DROP TABLE lock_probe`);
      await c.query(`DELETE FROM unfrozen_column WHERE table_name='lock_probe'`);
    });
  });
});

describe('non-delegable permissions', () => {
  it('hold release cannot be placed in a delegation, whatever the flag says', async () => {
    await expect(
      asOwner(async (c) => {
        const from = (await c.query(`SELECT id FROM user_account WHERE email=$1`, [USERS.qm])).rows[0].id;
        const to = (await c.query(`SELECT id FROM user_account WHERE email=$1`, [USERS.em])).rows[0].id;
        const p = (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id;
        return c.query(
          `INSERT INTO delegation (project_id, from_user_id, to_user_id, permission_codes,
                                   valid_period, signature_delegable, reason)
           VALUES ($1,$2,$3,ARRAY['checkpoint.hold.release'],
                   tstzrange(now(), now() + interval '7 days'), true, 'annual leave')`,
          [p, from, to],
        );
      }),
    ).rejects.toThrow(/LOTLINE_NOT_DELEGABLE/);
  });

  it('a retrospective release is equally non-delegable — lateness relaxes nothing', async () => {
    await expect(
      asOwner(async (c) => {
        const from = (await c.query(`SELECT id FROM user_account WHERE email=$1`, [USERS.qm])).rows[0].id;
        const to = (await c.query(`SELECT id FROM user_account WHERE email=$1`, [USERS.em])).rows[0].id;
        const p = (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id;
        return c.query(
          `INSERT INTO delegation (project_id, from_user_id, to_user_id, permission_codes,
                                   valid_period, reason)
           VALUES ($1,$2,$3,ARRAY['checkpoint.hold.release.retrospective'],
                   tstzrange(now(), now() + interval '7 days'), 'cover')`,
          [p, from, to],
        );
      }),
    ).rejects.toThrow(/LOTLINE_NOT_DELEGABLE/);
  });
});
