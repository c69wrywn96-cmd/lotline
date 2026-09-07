/**
 * ADR-0021: the device pattern. A shared site tablet is enrolled once under full
 * MFA; each user then unlocks with a PIN or platform passkey. The PIN binds to a
 * USER IDENTITY, not to the device — it is binding a signature.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb, userId, USERS } from './helpers';

afterAll(async () => { await appDb.end(); });

const newEvent = (opts: { user: string; strength: string; mfa: boolean; result?: string }) =>
  asOwner(async (c) =>
    (
      await c.query(
        `INSERT INTO authentication_event (user_id, method, strength, mfa_satisfied, result)
         VALUES ($1,'idp_reauth',$2,$3,$4) RETURNING id`,
        [opts.user, opts.strength, opts.mfa, opts.result ?? 'success'],
      )
    ).rows[0].id,
  );

describe('device enrolment', () => {
  it('a device cannot be trusted without a step-up, MFA-satisfied enrolment event', async () => {
    const uid = await userId(USERS.peA);
    const weak = await newEvent({ user: uid, strength: 'device_unlock', mfa: false });
    const proj = await asOwner(async (c) => (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);

    await expect(
      asOwner(async (c) =>
        c.query(
          `INSERT INTO device (project_id, label, platform, device_fingerprint,
                               enrolment_status, enrolled_by, enrolment_auth_event_id, enrolled_at)
           VALUES ($1,'weak tablet','android','fp-weak','trusted',$2,$3,now())`,
          [proj, uid, weak],
        ),
      ),
    ).rejects.toThrow(/LOTLINE_DEVICE_ENROLMENT_WEAK/);
  });

  it('a device cannot be trusted with no enrolment recorded at all', async () => {
    const proj = await asOwner(async (c) => (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    await expect(
      asOwner(async (c) =>
        c.query(
          `INSERT INTO device (project_id, label, platform, device_fingerprint, enrolment_status)
           VALUES ($1,'orphan tablet','android','fp-orphan','trusted')`,
          [proj],
        ),
      ),
      // Either guard is a correct rejection: the trigger runs first, the CHECK
      // constraint backs it up if the trigger is ever dropped.
    ).rejects.toThrow(/trusted_requires_mfa_enrolment|LOTLINE_DEVICE_ENROLMENT_INVALID/);
  });
});

describe('per-user unlock binds an identity, not a device', () => {
  it('a user cannot be enrolled on a device using someone else authentication', async () => {
    const peA = await userId(USERS.peA);
    const cadet = await userId(USERS.cadetA);
    const tablet = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM device WHERE device_fingerprint='fp-z3-tablet-02'`)).rows[0].id,
    );
    // An event belonging to the SECTION ENGINEER, used to enrol the CADET.
    const wrongUsersEvent = await newEvent({ user: peA, strength: 'step_up', mfa: true });

    await expect(
      asOwner(async (c) =>
        c.query(
          `INSERT INTO device_user_enrolment (device_id, user_id, credential_kind, pin_hash,
                                              enrolment_auth_event_id)
           VALUES ($1,$2,'pin','$argon2id$x',$3)`,
          [tablet, cadet, wrongUsersEvent],
        ),
      ),
    ).rejects.toThrow(/LOTLINE_USER_ENROLMENT_MISMATCH/);
  });

  it('a user cannot be enrolled without their own MFA authentication', async () => {
    const cadet = await userId(USERS.cadetA);
    const tablet = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM device WHERE device_fingerprint='fp-z3-tablet-02'`)).rows[0].id,
    );
    const noMfa = await newEvent({ user: cadet, strength: 'session', mfa: false });

    await expect(
      asOwner(async (c) =>
        c.query(
          `INSERT INTO device_user_enrolment (device_id, user_id, credential_kind, pin_hash,
                                              enrolment_auth_event_id)
           VALUES ($1,$2,'pin','$argon2id$x',$3)`,
          [tablet, cadet, noMfa],
        ),
      ),
    ).rejects.toThrow(/LOTLINE_USER_ENROLMENT_WEAK/);
  });

  it('no user may be enrolled on an untrusted device', async () => {
    const uid = await userId(USERS.peA);
    const proj = await asOwner(async (c) => (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    const pending = await asOwner(async (c) =>
      (
        await c.query(
          `INSERT INTO device (project_id, label, platform, device_fingerprint, enrolment_status)
           VALUES ($1,'not yet enrolled','android','fp-pending','pending') RETURNING id`,
          [proj],
        )
      ).rows[0].id,
    );
    const ev = await newEvent({ user: uid, strength: 'step_up', mfa: true });

    await expect(
      asOwner(async (c) =>
        c.query(
          `INSERT INTO device_user_enrolment (device_id, user_id, credential_kind, pin_hash,
                                              enrolment_auth_event_id)
           VALUES ($1,$2,'pin','$argon2id$x',$3)`,
          [pending, uid, ev],
        ),
      ),
    ).rejects.toThrow(/LOTLINE_DEVICE_NOT_TRUSTED/);
  });

  it('the seeded tablet yields a complete signature chain back to an MFA login', async () => {
    // signature <- unlock enrolment <- that user's own step-up MFA event.
    const chain = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT u.full_name, e.strength, e.mfa_satisfied, d.enrolment_status
             FROM device_user_enrolment due
             JOIN device d ON d.id = due.device_id
             JOIN authentication_event e ON e.id = due.enrolment_auth_event_id
             JOIN user_account u ON u.id = due.user_id
            WHERE d.device_fingerprint = 'fp-z3-tablet-02'
            ORDER BY u.full_name`,
        )
      ).rows,
    );
    expect(chain.length).toBe(2);
    for (const link of chain) {
      expect(link.enrolment_status).toBe('trusted');
      expect(link.mfa_satisfied).toBe(true);
      expect(link.strength).toBe('step_up');
    }
  });
});

describe('authentication strength is data, not scattered conditionals', () => {
  it('hold release and conformance certification require step-up', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT code, min_auth_strength FROM permission
            WHERE code IN ('checkpoint.hold.release','checkpoint.hold.release.retrospective',
                           'lot.certify_conformance','lot.accept','signature.withdraw')
            ORDER BY code`,
        )
      ).rows,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.min_auth_strength, r.code).toBe('step_up');
  });

  it('field actions do not require step-up, or the product is unusable on site', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT code, min_auth_strength FROM permission
            WHERE code IN ('checkpoint.evidence.attach','checkpoint.action','lot.view')`,
        )
      ).rows,
    );
    for (const r of rows) expect(r.min_auth_strength, r.code).toBe('session');
  });

  it('administration is unavailable on a shared device session, regardless of role', async () => {
    const rows = await asOwner(async (c) =>
      (
        await c.query(
          `SELECT code FROM permission
            WHERE device_bound_allowed = true
              AND (code LIKE 'admin.%' OR code LIKE 'api.%' OR code LIKE 'export.%')`,
        )
      ).rows,
    );
    expect(rows.map((r) => r.code)).toEqual([]);
  });
});

describe('home-realm discovery', () => {
  it('an email domain cannot be routed by two active identity providers', async () => {
    const org = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM organisation WHERE org_type='verifier' LIMIT 1`)).rows[0].id,
    );
    await expect(
      asOwner(async (c) =>
        c.query(
          `INSERT INTO org_identity_provider (organisation_id, protocol, issuer, client_id,
                                              allowed_email_domains, status)
           VALUES ($1,'oidc','https://impostor.example/','lotline',
                   ARRAY['ardentsuper.com.au'],'active')`,
          [org],
        ),
      ),
    ).rejects.toThrow(/LOTLINE_IDP_DOMAIN_CLASH/);
  });
});
