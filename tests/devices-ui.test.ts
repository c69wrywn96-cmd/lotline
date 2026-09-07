/**
 * Device enrolment and management — the data layer behind the screens.
 *
 * This is the feature with no off-the-shelf precedent and the one where a UI can
 * quietly undermine the security model, so the properties below are asserted
 * against the real functions the screens call, not against the rendered page.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { asOwner, appDb, userId, USERS } from './helpers';
import {
  listDevices, getDevice, enrolDevice, revokeDevice, revokeUserEnrolment,
  describeUserEnrolmentProcess, DeviceActionError,
} from '../src/app/devices/data';
import { recordAuthenticationEvent, buildSessionContext } from '../src/auth/session-bridge';
import { PermissionError } from '../src/auth/permissions';
import type { SessionContext } from '../src/db/session';
import { randomUUID } from 'node:crypto';

afterAll(async () => { await appDb.end(); });

async function projectId(): Promise<string> {
  return asOwner(async (c) =>
    (await c.query(`SELECT id FROM project WHERE code='MRU2'`)).rows[0].id);
}

/** A realistic signed-in session, anchored to a recorded authentication event. */
async function session(
  email: string,
  opts: { method?: 'idp_reauth' | 'device_pin'; deviceId?: string } = {},
): Promise<SessionContext> {
  const uid = await userId(email);
  return asOwner(async (c) => {
    const ev = await recordAuthenticationEvent(c, {
      userId: uid,
      method: opts.method ?? 'idp_reauth',
      mfaSatisfied: true,
      deviceId: opts.deviceId,
      deviceBoundSession: opts.deviceId != null,
    });
    return buildSessionContext(c, {
      userId: uid, authEventId: ev, requestId: randomUUID(), deviceId: opts.deviceId,
    });
  });
}

async function run<T>(ctx: SessionContext, fn: (db: any) => Promise<T>): Promise<T> {
  return appDb.withSession(ctx, fn);
}

describe('an administrator cannot set a user PIN — anywhere', () => {
  it('no function in the device module accepts a credential', async () => {
    // A structural assertion, because this is the mistake the UI would make.
    const source = readFileSync(new URL('../src/app/devices/data.ts', import.meta.url), 'utf8');
    // Field names that would carry a secret into an admin-callable function.
    for (const forbidden of ['pin:', 'pinHash', 'passkey:', 'credential:', 'secret:']) {
      expect(source, `device data layer must not accept ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the database refuses it even if a future UI tried', async () => {
    const admin = await userId(USERS.qm);
    const target = await userId(USERS.peB);
    const tablet = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM device WHERE device_fingerprint='fp-z3-tablet-02'`)).rows[0].id);

    // The admin's own MFA event, used to enrol somebody else. This is the exact
    // shape of "the admin set the user's PIN", and it is rejected.
    await expect(
      asOwner(async (c) => {
        const ev = await recordAuthenticationEvent(c, {
          userId: admin, method: 'idp_reauth', mfaSatisfied: true,
        });
        return c.query(
          `INSERT INTO device_user_enrolment (device_id, user_id, credential_kind, pin_hash,
                                              enrolment_auth_event_id)
           VALUES ($1,$2,'pin','$argon2id$set-by-admin',$3)`,
          [tablet, target, ev],
        );
      }),
    ).rejects.toThrow(/LOTLINE_USER_ENROLMENT_MISMATCH/);
  });

  it('what an admin CAN do is described honestly to them', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const described = await run(ctx, (db) => describeUserEnrolmentProcess(db, p));
    expect(described.canAuthorise).toBe(true);
    expect(described.steps.join(' ')).toMatch(/their own PIN/);
    expect(described.steps.join(' ')).toMatch(/nobody else, including an administrator/i);
  });
});

describe('device trust and user enrolment are visibly different states', () => {
  it('a freshly enrolled device has zero people who can unlock it', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const id = await run(ctx, (db) =>
      enrolDevice(db, ctx, {
        projectId: p, label: 'Zone 5 crew tablet 01', platform: 'android',
        deviceFingerprint: `fp-${randomUUID()}`, isShared: true,
      }));

    const detail = await run(ctx, (db) => getDevice(db, id));
    expect(detail?.enrolmentStatus).toBe('trusted');
    // The number the screen must show. A trusted tablet nobody is enrolled on
    // cannot sign anything, and the UI must not imply otherwise.
    expect(detail?.activeEnrolments).toBe(0);
    expect(detail?.enrolledUsers).toEqual([]);
  });

  it('the enrolment chain is visible: who authorised the device, and how strongly', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    const id = await run(ctx, (db) =>
      enrolDevice(db, ctx, {
        projectId: p, label: 'Site office desk 02', platform: 'windows',
        deviceFingerprint: `fp-${randomUUID()}`, isShared: false,
      }));

    const detail = await run(ctx, (db) => getDevice(db, id));
    expect(detail?.enrolledByName).toBe('Priya Nandakumar');
    expect(detail?.enrolmentStrength).toBe('step_up');
    expect(detail?.enrolmentMfaSatisfied).toBe(true);
  });

  it('each enrolled user shows the authentication that bound them', async () => {
    const ctx = await session(USERS.qm);
    const tablet = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM device WHERE device_fingerprint='fp-z3-tablet-02'`)).rows[0].id);
    const detail = await run(ctx, (db) => getDevice(db, tablet));

    expect(detail?.enrolledUsers.length).toBe(2);
    for (const u of detail!.enrolledUsers) {
      // The screen shows this so a supervisor can see the unlock is anchored to
      // that person's own multi-factor login, not to the device.
      expect(u.boundByMfaSatisfied).toBe(true);
      expect(u.credentialKind).toBe('pin');
    }
    expect(detail?.enrolledUsers.map((u) => u.fullName).sort())
      .toEqual(['Jarrah Okafor', 'Rowan Silvestri']);
  });
});

describe('enrolment authority', () => {
  it('a foreman cannot enrol a device', async () => {
    const ctx = await session(USERS.foreman);
    const p = await projectId();
    await expect(
      run(ctx, (db) =>
        enrolDevice(db, ctx, {
          projectId: p, label: 'rogue', platform: 'android',
          deviceFingerprint: `fp-${randomUUID()}`, isShared: true,
        })),
    ).rejects.toThrow(PermissionError);
  });

  it('a device cannot be enrolled FROM a shared device, and the refusal explains why', async () => {
    const tablet = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM device WHERE device_fingerprint='fp-z3-tablet-02'`)).rows[0].id);
    // Jarrah is enrolled on the tablet and holds admin.device.enrol.
    const ctx = await session(USERS.peA, { method: 'device_pin', deviceId: tablet });
    const p = await projectId();

    const err = await run(ctx, (db) =>
      enrolDevice(db, ctx, {
        projectId: p, label: 'bootstrapped', platform: 'android',
        deviceFingerprint: `fp-${randomUUID()}`, isShared: true,
      }).catch((e) => e));

    // Either guard is correct: the permission is device_bound_allowed=false, and
    // the module refuses before reaching it so the message is a useful one.
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/shared|not_available_on_shared_device/i);
  });

  it('a label is required — an unlabelled tablet is unidentifiable on site', async () => {
    const ctx = await session(USERS.qm);
    const p = await projectId();
    await expect(
      run(ctx, (db) =>
        enrolDevice(db, ctx, {
          projectId: p, label: '   ', platform: 'android',
          deviceFingerprint: `fp-${randomUUID()}`, isShared: true,
        })),
    ).rejects.toThrow(DeviceActionError);
  });
});

describe('revocation is immediate, total and always available', () => {
  it('revoking a device stops an already-open session on the next request', async () => {
    const admin = await session(USERS.qm);
    const p = await projectId();
    const fingerprint = `fp-${randomUUID()}`;
    const id = await run(admin, (db) =>
      enrolDevice(db, admin, {
        projectId: p, label: 'Temporary hire tablet', platform: 'android',
        deviceFingerprint: fingerprint, isShared: true,
      }));

    // Enrol a user on it, the only way that is possible: their own MFA.
    const uid = await userId(USERS.peA);
    const userSessionEvent = await asOwner(async (c) => {
      const ev = await recordAuthenticationEvent(c, {
        userId: uid, method: 'idp_primary', mfaSatisfied: true, deviceId: id,
      });
      await c.query(
        `INSERT INTO device_user_enrolment (device_id, user_id, credential_kind, pin_hash,
                                            enrolment_auth_event_id)
         VALUES ($1,$2,'pin','$argon2id$chosen-by-user',$3)`,
        [id, uid, ev]);
      return recordAuthenticationEvent(c, {
        userId: uid, method: 'device_pin', mfaSatisfied: true,
        deviceId: id, deviceBoundSession: true,
      });
    });

    // The field session works...
    const ok = await asOwner(async (c) =>
      buildSessionContext(c, {
        userId: uid, authEventId: userSessionEvent, requestId: randomUUID(), deviceId: id,
      }));
    expect(ok.deviceBound).toBe(true);

    await run(admin, (db) => revokeDevice(db, admin, id, p, 'left in a ute overnight'));

    // ...and stops at the very next request, without waiting for expiry.
    await expect(
      asOwner(async (c) =>
        buildSessionContext(c, {
          userId: uid, authEventId: userSessionEvent, requestId: randomUUID(), deviceId: id,
        })),
    ).rejects.toThrow(/device_not_trusted/);

    const detail = await run(admin, (db) => getDevice(db, id));
    expect(detail?.enrolmentStatus).toBe('revoked');
    expect(detail?.revokeReason).toBe('left in a ute overnight');
  });

  it('revocation demands a reason', async () => {
    const admin = await session(USERS.qm);
    const p = await projectId();
    const id = await run(admin, (db) =>
      enrolDevice(db, admin, {
        projectId: p, label: 'Reason test', platform: 'ios',
        deviceFingerprint: `fp-${randomUUID()}`, isShared: false,
      }));
    const err = await run(admin, (db) =>
      revokeDevice(db, admin, id, p, '  ').catch((e) => e));
    expect(err).toBeInstanceOf(DeviceActionError);
    expect((err as DeviceActionError).code).toBe('reason_required');
  });

  it('one person can be removed without revoking the tablet the crew still needs', async () => {
    const admin = await session(USERS.qm);
    const p = await projectId();

    // Builds its own device rather than revoking someone from the SEEDED tablet:
    // other suites sign in on that tablet, and a test that quietly retires a
    // shared fixture makes the next failure someone else's problem.
    const tablet = await run(admin, (db) =>
      enrolDevice(db, admin, {
        projectId: p, label: 'Crew handover tablet', platform: 'android',
        deviceFingerprint: `fp-${randomUUID()}`, isShared: true,
      }));

    for (const email of [USERS.peA, USERS.cadetA]) {
      const uid = await userId(email);
      await asOwner(async (c) => {
        const ev = await recordAuthenticationEvent(c, {
          userId: uid, method: 'idp_primary', mfaSatisfied: true, deviceId: tablet,
        });
        await c.query(
          `INSERT INTO device_user_enrolment (device_id, user_id, credential_kind, pin_hash,
                                              enrolment_auth_event_id)
           VALUES ($1,$2,'pin','$argon2id$chosen-by-user',$3)`,
          [tablet, uid, ev]);
      });
    }

    const before = await run(admin, (db) => getDevice(db, tablet));
    expect(before?.activeEnrolments).toBe(2);
    const cadet = before!.enrolledUsers.find((u) => u.fullName === 'Rowan Silvestri')!;

    await run(admin, (db) => revokeUserEnrolment(db, admin, cadet.enrolmentId, p));

    const after = await run(admin, (db) => getDevice(db, tablet));
    expect(after?.enrolmentStatus, 'the tablet stays trusted').toBe('trusted');
    expect(after?.enrolledUsers.map((u) => u.fullName)).toEqual(['Jarrah Okafor']);
    expect(after?.activeEnrolments).toBe(1);
  });

  it('a foreman cannot revoke a device', async () => {
    const ctx = await session(USERS.foreman);
    const p = await projectId();
    const tablet = await asOwner(async (c) =>
      (await c.query(`SELECT id FROM device WHERE device_fingerprint='fp-z3-tablet-02'`)).rows[0].id);
    await expect(
      run(ctx, (db) => revokeDevice(db, ctx, tablet, p, 'not mine to revoke')),
    ).rejects.toThrow(PermissionError);
  });
});

describe('the device list is scoped like everything else', () => {
  it('a subcontractor sees no devices on the project', async () => {
    const ctx = await session(USERS.subEarth);
    const p = await projectId();
    const devices = await run(ctx, (db) => listDevices(db, p));
    expect(devices).toEqual([]);
  });

  it('a contractor engineer sees the project devices', async () => {
    const ctx = await session(USERS.peA);
    const p = await projectId();
    const devices = await run(ctx, (db) => listDevices(db, p));
    expect(devices.length).toBeGreaterThan(0);
    expect(devices.some((d) => d.label === 'Zone 3 site office tablet 02')).toBe(true);
  });
});
