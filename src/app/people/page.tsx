import { db } from '../../lib/db';
import { currentSession } from '../../lib/session';
import { listPeople, listRoles, listMembershipChanges } from './data';

export const dynamic = 'force-dynamic';

function Scope({ read, write }: { read: string | null; write: string | null }) {
  if (!read) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <span className="mono">
      reads <strong>{read}</strong>
      {' · '}
      {write ? <>writes <strong>{write}</strong></>
             : <span style={{ color: 'var(--muted)' }}>read only</span>}
    </span>
  );
}

export default async function PeoplePage({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams;
  if (!project) return <main className="wrap"><p className="sub">Select a project.</p></main>;

  const ctx = await currentSession();
  const [people, roles, changes] = await db.withSession(ctx, async (client) => [
    await listPeople(client, project),
    await listRoles(client),
    await listMembershipChanges(client, project, 20),
  ] as const);

  const byName = new Map(people.map((p) => [p.userId, p.fullName]));

  return (
    <main className="wrap">
      <h1>People</h1>
      <p className="sub">
        Who is on this project, what they may do, and where. Scope says
        <em> where</em>; the role says <em>what</em>.
      </p>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Person</th><th>Organisation</th><th>Roles</th>
              <th>Scope</th><th>Sign-in</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.userId}>
                <td>
                  {p.fullName}
                  <div className="mono" style={{ color: 'var(--muted)' }}>{p.email}</div>
                </td>
                <td>
                  {p.organisation}
                  {/* The side of the contract someone sits on is the thing you
                      must never get wrong, so it is shown, not implied. */}
                  {p.side && p.side !== 'contractor' && (
                    <div className="mono" style={{ color: 'var(--accent)' }}>{p.side}</div>
                  )}
                </td>
                <td>
                  {p.roles.length === 0
                    ? <span style={{ color: 'var(--muted)' }}>—</span>
                    : p.roles.map((r) => (
                        <div key={`${r.code}-${r.via}`} className="mono">
                          {r.code}
                          {r.via === 'organisation' && (
                            <span style={{ color: 'var(--muted)' }}> · via organisation</span>
                          )}
                        </div>
                      ))}
                </td>
                <td><Scope read={p.readScope} write={p.writeScope} /></td>
                <td className="mono" style={{ color: 'var(--muted)' }}>{p.authPattern}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Roles</h2>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Role</th><th>Side</th><th>Scope level</th><th>Permissions</th></tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td><span className="mono">{r.code}</span> — {r.name}</td>
                <td className="mono">{r.side}</td>
                <td className="mono">{r.scopeLevel}</td>
                <td>
                  {r.permissionCount}
                  {/* How many of a role's permissions demand step-up is the
                      clearest single measure of its weight. */}
                  {r.stepUpCount > 0 && (
                    <span style={{ color: 'var(--warn)' }}>
                      {' · '}{r.stepUpCount} need step-up
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recent authority changes</h2>
      <p className="sub">
        Read from the audit log, not a separate table, so it cannot drift from
        what actually happened.
      </p>
      <div className="panel">
        {changes.length === 0 ? (
          <p className="empty">No membership changes recorded.</p>
        ) : (
          <table>
            <thead>
              <tr><th>When</th><th>By</th><th>Action</th><th>Subject</th></tr>
            </thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={`${c.occurredAt.toISOString()}-${i}`}>
                  <td className="mono">{c.occurredAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
                  <td>{c.actorName ?? <span style={{ color: 'var(--muted)' }}>system</span>}</td>
                  <td className="mono">{c.action}</td>
                  <td>{c.subjectUserId ? byName.get(c.subjectUserId) ?? '—' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
