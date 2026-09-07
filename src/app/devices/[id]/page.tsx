import { notFound } from 'next/navigation';
import { db } from '../../../lib/db';
import { currentSession } from '../../../lib/session';
import { getDevice, describeUserEnrolmentProcess } from '../data';

export const dynamic = 'force-dynamic';

export default async function DevicePage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { id } = await params;
  const { project } = await searchParams;
  const ctx = await currentSession();

  const [device, process] = await db.withSession(ctx, async (client) => [
    await getDevice(client, id),
    project ? await describeUserEnrolmentProcess(client, project) : null,
  ] as const);

  // A device outside the caller's scope is absent, not forbidden.
  if (!device) notFound();

  return (
    <main className="wrap">
      <h1>{device.label}</h1>
      <p className="sub">
        <span className={`tag tag-${device.enrolmentStatus}`}>{device.enrolmentStatus}</span>
        {' '}<span className="mono">{device.deviceFingerprint}</span>
      </p>

      <h2>Device trust</h2>
      <div className="panel" style={{ padding: '14px' }}>
        <div className="chain">
          enrolled by {device.enrolledByName ?? '—'}
          {device.enrolmentMethod && (
            <> · via {device.enrolmentMethod} · strength {device.enrolmentStrength}
              {device.enrolmentMfaSatisfied ? ' · MFA satisfied' : ' · MFA NOT satisfied'}</>
          )}
        </div>
        {device.revokedAt && (
          <div className="chain" style={{ color: 'var(--stop)', marginTop: 8 }}>
            revoked {device.revokedAt.toISOString()} — {device.revokeReason}
          </div>
        )}
      </div>

      <h2>Who can unlock this device</h2>
      {device.enrolledUsers.length === 0 ? (
        <div className="panel">
          <p className="empty">
            Nobody is enrolled. This device is trusted hardware, but nobody can sign on it yet.
          </p>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr><th>Person</th><th>Unlock</th><th>Bound by</th><th>Since</th></tr>
            </thead>
            <tbody>
              {device.enrolledUsers.map((u) => (
                <tr key={u.enrolmentId}>
                  <td>{u.fullName}<div className="mono" style={{ color: 'var(--muted)' }}>{u.email}</div></td>
                  <td className="mono">
                    {u.credentialKind === 'pin' ? 'PIN' : 'Passkey'}
                    {u.lockedUntil && <span style={{ color: 'var(--warn)' }}> · locked</span>}
                  </td>
                  {/* The evidence a supervisor needs: the unlock is anchored to
                      that person's own multi-factor login, not to the device. */}
                  <td className="chain">
                    {u.boundByMethod}
                    {u.boundByMfaSatisfied ? ' · MFA satisfied' : ' · MFA NOT satisfied'}
                  </td>
                  <td className="mono">{u.enrolledAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {process?.canAuthorise && (
        <div className="note">
          <strong>Adding someone to this device</strong>
          <ol className="steps">
            {process.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}
    </main>
  );
}
