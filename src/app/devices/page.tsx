import Link from 'next/link';
import { db } from '../../lib/db';
import { currentSession } from '../../lib/session';
import { listDevices } from './data';

export const dynamic = 'force-dynamic';

function StatusTag({ status }: { status: 'pending' | 'trusted' | 'revoked' }) {
  return <span className={`tag tag-${status}`}>{status}</span>;
}

export default async function DevicesPage({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams;
  if (!project) return <main className="wrap"><p className="sub">Select a project.</p></main>;

  const ctx = await currentSession();
  const devices = await db.withSession(ctx, (client) => listDevices(client, project));

  return (
    <main className="wrap">
      <h1>Devices</h1>
      <p className="sub">
        Site devices enrolled on this project. Enrolling a device establishes that
        the hardware is ours; it says nothing about who may unlock it.
      </p>

      <div className="panel">
        {devices.length === 0 ? (
          <p className="empty">No devices enrolled on this project.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Device</th><th>Status</th><th>Type</th><th>Zone</th>
                <th>Can unlock</th><th>Enrolled by</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/devices/${d.id}?project=${project}`}>{d.label}</Link>
                    <div className="mono" style={{ color: 'var(--muted)' }}>{d.platform}</div>
                  </td>
                  <td><StatusTag status={d.enrolmentStatus} /></td>
                  <td>{d.isShared ? 'Shared' : 'Personal'}</td>
                  <td className="mono">{d.zoneCode ?? '—'}</td>
                  <td>
                    {/* Zero is the state that matters: a trusted tablet nobody
                        is enrolled on cannot sign anything. */}
                    <span className={d.activeEnrolments === 0 ? 'count-zero' : undefined}>
                      {d.activeEnrolments === 0
                        ? 'nobody yet'
                        : `${d.activeEnrolments} ${d.activeEnrolments === 1 ? 'person' : 'people'}`}
                    </span>
                  </td>
                  <td>
                    {d.enrolledByName ?? '—'}
                    {d.revokedAt && (
                      <div className="mono" style={{ color: 'var(--stop)' }}>
                        revoked — {d.revokeReason}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
