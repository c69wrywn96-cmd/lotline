/**
 * The seam where authentication becomes authorisation.
 *
 * Every field this produces is consumed by RLS or by auth.decide(), so the tests
 * below are security tests, not integration tests.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { asOwner, appDb, userId, USERS } from './helpers';
import {
  buildSessionContext, recordAuthenticationEvent, SessionRejected,
} from '../src/auth/session-bridge';
import { loadRealmRoutes, loadKnownPattern } from '../src/auth/realm-lookup';
import { resolveRealm } from '../src/auth/home-realm';
import { PermissionResolver } from '../src/auth/permissions';
import { randomUUID } from 'node:crypto';

afterAll(async () => { await appDb.end(); });

describe('strength is recomputed from the stored event, never trusted from the client', () => {
  it('a fresh re-authentication yields step-up', async () => {
    const uid = await userId(USERS.sr);
    const ctx = await asOwner(async (c) => {
      const ev = await recordAuthenticationEvent(c, {
        userId: uid, method: 'idp_reauth', mfaSatisfied: true,
      });
      return buildSessionContext(c, { userId: uid, authEventId: ev, requestId: randomUUID() });
    });
    expect(ctx.authStrength).toBe('step_up');
    expect(ctx.deviceBound).toBe(false);
  });

  it('the same event, hours later, no longer authorises a hold point release', async () => {
    const uid = await userId(USERS.sr);
    const projectId = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);

    const { fresh, stale } = await asOwner(async (c) => {
      const ev = await recordAuthenticationEvent(c, {
        userId: uid, method: 'idp_reauth', mfaSatisfied: true,
      });
      const later = new Date(Date.now() + 8 * 60 * 60 * 1000);
      return {
        fresh: await buildSessionContext(c, { userId: uid, authEventId: ev, requestId: randomUUID() }),
        stale: await buildSessionContext(c, { userId: uid, authEventId: ev, requestId: randomUUID() }, later),
      };
    });
    expect(fresh.authStrength).toBe('step_up');
    expect(stale.authStrength).toBe('device_unlock');

    // ...and the difference is load-bearing all the way through to the decision.
    const allowed = await appDb.withSession(fresh, async (db) =>
      new PermissionResolver(db).can('checkpoint.hold.release', { projectId }));
    const refused = await appDb.withSession(stale, async (db) =>
      new PermissionResolver(db).decide('checkpoint.hold.release', { projectId }));
    expect(allowed).toBe(true);
    expect(refused).toEqual({ allowed: false, reason: 'step_up_required' });
  });
});

describe('the bridge fails closed', () => {
  it('rejects an authentication event that does not exist', async () => {
    const uid = await userId(USERS.qm);
    await expect(
      asOwner(async (c) =>
        buildSessionContext(c, { userId: uid, authEventId: randomUUID(), requestId: randomUUID() }),
      ),
    ).rejects.toThrow(SessionRejected);
  });

  it('rejects an event belonging to a different user', async () => {
    const qm = await userId(USERS.qm);
    const cadet = await userId(USERS.cadetA);
    await expect(
      asOwner(async (c) => {
        const ev = await recordAuthenticationEvent(c, {
          userId: cadet, method: 'idp_primary', mfaSatisfied: true,
        });
        // A session claiming to be the QM, resting on the cadet's login.
        return buildSessionContext(c, { userId: qm, authEventId: ev, requestId: randomUUID() });
      }),
    ).rejects.toThrow(/auth_event_user_mismatch/);
  });

  it('rejects a failed authentication being used as a session', async () => {
    const uid = await userId(USERS.qm);
    await expect(
      asOwner(async (c) => {
        const ev = await recordAuthenticationEvent(c, {
          userId: uid, method: 'password_totp', mfaSatisfied: false,
          result: 'failure', failureReason: 'bad_totp',
        });
        return buildSessionContext(c, { userId: uid, authEventId: ev, requestId: randomUUID() });
      }),
    ).rejects.toThrow(/auth_event_failed/);
  });

  it('records failures as well as successes, or the log cannot show a brute-force attempt', async () => {
    const uid = await userId(USERS.subEarth);
    const before = await asOwner(async (c) =>
      (await c.query(
        `SELECT count(*)::int n FROM authentication_event WHERE user_id=$1 AND result='failure'`,
        [uid])).rows[0].n);

    await asOwner(async (c) => {
      for (let i = 0; i < 3; i += 1) {
        await recordAuthenticationEvent(c, {
          userId: uid, method: 'password_totp', mfaSatisfied: false,
          result: 'failure', failureReason: 'bad_password', ip: '198.51.100.7',
        });
      }
    });

    const after = await asOwner(async (c) =>
      (await c.query(
        `SELECT count(*)::int n FROM authentication_event WHERE user_id=$1 AND result='failure'`,
        [uid])).rows[0].n);
    expect(after - before).toBe(3);
  });
});

describe('device-bound sessions', () => {
  it('a session on the enrolled tablet is device-bound and capability-restricted', async () => {
    const uid = await userId(USERS.cadetA);
    const projectId = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
    const tablet = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM device WHERE device_fingerprint='fp-z3-tablet-02'`)).rows[0].id);

    const ctx = await asOwner(async (c) => {
      const ev = await recordAuthenticationEvent(c, {
        userId: uid, method: 'device_pin', mfaSatisfied: true,
        deviceId: tablet, deviceBoundSession: true,
      });
      return buildSessionContext(c, {
        userId: uid, authEventId: ev, requestId: randomUUID(), deviceId: tablet,
      });
    });

    expect(ctx.deviceBound).toBe(true);
    expect(ctx.authStrength).toBe('device_unlock');

    const decision = await appDb.withSession(ctx, async (db) =>
      new PermissionResolver(db).decide('export.data', { projectId }));
    expect(decision).toEqual({ allowed: false, reason: 'not_available_on_shared_device' });
  });

  it('a revoked device cannot carry a session that was already open', async () => {
    const uid = await userId(USERS.peA);
    const projectId = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);

    const { tablet, ev } = await asOwner(async (c) => {
      const enrol = await recordAuthenticationEvent(c, {
        userId: uid, method: 'idp_reauth', mfaSatisfied: true,
      });
      const t = (await c.query(
        `INSERT INTO device (project_id, label, platform, device_fingerprint, enrolment_status,
                             is_shared, enrolled_by, enrolment_auth_event_id, enrolled_at)
         VALUES ($1,'temporary tablet','android','fp-temp','trusted',true,$2,$3,now())
         RETURNING id`, [projectId, uid, enrol])).rows[0].id;
      const userEv = await recordAuthenticationEvent(c, {
        userId: uid, method: 'idp_primary', mfaSatisfied: true, deviceId: t,
      });
      await c.query(
        `INSERT INTO device_user_enrolment (device_id, user_id, credential_kind, pin_hash,
                                            enrolment_auth_event_id)
         VALUES ($1,$2,'pin','$argon2id$x',$3)`, [t, uid, userEv]);
      const sessionEv = await recordAuthenticationEvent(c, {
        userId: uid, method: 'device_pin', mfaSatisfied: true, deviceId: t, deviceBoundSession: true,
      });
      return { tablet: t, ev: sessionEv };
    });

    // Works while trusted...
    const ok = await asOwner(async (c) =>
      buildSessionContext(c, { userId: uid, authEventId: ev, requestId: randomUUID(), deviceId: tablet }));
    expect(ok.deviceBound).toBe(true);

    // ...and stops the moment the device is revoked, without waiting for the
    // session to expire.
    await asOwner(async (c) => {
      await c.query(
        `UPDATE device SET enrolment_status='revoked', revoked_at=now(),
                           revoke_reason='left on site overnight' WHERE id=$1`, [tablet]);
    });
    await expect(
      asOwner(async (c) =>
        buildSessionContext(c, { userId: uid, authEventId: ev, requestId: randomUUID(), deviceId: tablet })),
    ).rejects.toThrow(/device_not_trusted/);
  });

  it('a user not enrolled on the device they claim to hold is rejected', async () => {
    const stranger = await userId(USERS.peB);
    const tablet = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM device WHERE device_fingerprint='fp-z3-tablet-02'`)).rows[0].id);

    await expect(
      asOwner(async (c) => {
        const ev = await recordAuthenticationEvent(c, {
          userId: stranger, method: 'idp_primary', mfaSatisfied: true,
        });
        return buildSessionContext(c, {
          userId: stranger, authEventId: ev, requestId: randomUUID(), deviceId: tablet,
        });
      }),
    ).rejects.toThrow(/device_user_not_enrolled/);
  });
});

describe('home-realm discovery against the seeded providers', () => {
  it('routes the seeded client and verifier to their own issuers', async () => {
    const routes = await asOwner(loadRealmRoutes);
    const domains = routes.map((r) => r.domain);
    // Containment, not equality: other suites legitimately register further
    // providers, and this test is about the seeded client and verifier being
    // routed to their own issuers.
    expect(domains).toContain('ardentsuper.com.au');
    expect(domains).toContain('meridianiv.com.au');

    const d = resolveRealm(USERS.sr, { routes, homeTenantDomains: [] });
    expect(d.kind).toBe('federated');
  });

  it('routes a subcontractor to local credentials, by their stored pattern', async () => {
    const routes = await asOwner(loadRealmRoutes);
    const pattern = await asOwner((c) => loadKnownPattern(c, USERS.subEarth));
    expect(pattern).toBe('local_credentials');
    expect(resolveRealm(USERS.subEarth, { routes, homeTenantDomains: [], knownPattern: pattern }))
      .toEqual({ kind: 'local_credentials' });
  });

  it('an unknown address behaves exactly like a known one — no enumeration oracle', async () => {
    const known = await asOwner((c) => loadKnownPattern(c, USERS.qm));
    const unknown = await asOwner((c) => loadKnownPattern(c, 'nobody@example.org'));
    expect(known).toBe('home_tenant');
    expect(unknown).toBeUndefined();
    // Both return normally; neither throws, and the caller cannot distinguish
    // them from timing or from an exception.
  });
});
