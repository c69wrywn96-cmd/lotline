import { routeForEmail } from '../../auth/config';

export const dynamic = 'force-dynamic';

/**
 * Home-realm discovery, as a screen.
 *
 * The address is entered first and the form then shows only the route that
 * applies. A client agency lands on their own provider rather than being offered
 * a password box they do not have, and a subcontractor is not sent to an SSO
 * button that will never work for them.
 *
 * An unrecognised address gets the same neutral response as a recognised one —
 * the form must not become an account-enumeration oracle.
 */
export default async function SignInPage({
  searchParams,
}: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  const decision = email ? await routeForEmail(email) : null;

  return (
    <main className="wrap" style={{ maxWidth: 460 }}>
      <h1>Lotline</h1>
      <p className="sub">Sign in to continue.</p>

      <form method="GET" className="panel" style={{ padding: 20 }}>
        <label htmlFor="email" style={{ display: 'block', marginBottom: 6 }}>
          Work email address
        </label>
        <input
          id="email" name="email" type="email" required autoComplete="username"
          defaultValue={email ?? ''}
          style={{
            width: '100%', padding: '9px 11px', borderRadius: 4,
            border: '1px solid var(--rule)', background: 'var(--ink)',
            color: 'var(--text)', fontFamily: 'var(--mono)',
          }}
        />
        <button
          type="submit"
          style={{
            marginTop: 14, width: '100%', padding: '9px 12px', borderRadius: 4,
            border: '1px solid var(--rule)', background: 'var(--panel-2)',
            color: 'var(--text)', cursor: 'pointer',
          }}
        >
          Continue
        </button>
      </form>

      {decision?.kind === 'federated' && (
        <div className="note">
          <strong>{email}</strong> signs in through your organisation&rsquo;s identity provider.
          <form action="/api/auth/signin/microsoft-entra-id" method="POST" style={{ marginTop: 12 }}>
            <button type="submit">Continue to your provider</button>
          </form>
        </div>
      )}

      {decision?.kind === 'home_tenant' && (
        <div className="note">
          <strong>{email}</strong> signs in with your work account.
          <form action="/api/auth/signin/microsoft-entra-id" method="POST" style={{ marginTop: 12 }}>
            <button type="submit">Continue with single sign-on</button>
          </form>
        </div>
      )}

      {decision?.kind === 'local_credentials' && (
        <form action="/api/auth/callback/local" method="POST" className="panel"
              style={{ padding: 20, marginTop: 16 }}>
          <input type="hidden" name="email" value={email} />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required
                 autoComplete="current-password" style={{ width: '100%', marginBottom: 12 }} />
          <label htmlFor="secondFactor">Authenticator code</label>
          <input id="secondFactor" name="secondFactor" inputMode="numeric"
                 autoComplete="one-time-code" required style={{ width: '100%' }} />
          <button type="submit" style={{ marginTop: 14 }}>Sign in</button>
        </form>
      )}

      {decision?.kind === 'unknown' && (
        // Deliberately identical in tone to a recognised address: the form
        // reveals nothing about whether the account exists.
        <div className="note">
          If that address has an account, its sign-in method will be shown here.
          Check the address, or ask your project administrator.
        </div>
      )}
    </main>
  );
}
