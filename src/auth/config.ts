/**
 * Auth.js configuration — the four patterns of ADR-0021.
 *
 * The security decisions do NOT live here. Realm routing is in home-realm.ts,
 * credential verification in credentials.ts, strength derivation in strength.ts,
 * and the request→session translation in session-bridge.ts. This file wires
 * them to Auth.js and does nothing else, so that swapping the framework does not
 * put any of those rules in play.
 *
 * The session carries a user id and an authentication_event id, and NOTHING
 * else that authorisation depends on. In particular it does not carry the
 * strength: that is recomputed from the stored event on every request, because a
 * client-supplied strength claim would hand the entire authorisation model to
 * anyone able to set a cookie.
 */
import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import pg from 'pg';
import { authenticateWithPassword } from './credentials';
import { recordAuthenticationEvent } from './session-bridge';
import { loadRealmRoutes, loadKnownPattern } from './realm-lookup';
import { resolveRealm } from './home-realm';

const ownerUrl = () =>
  process.env.DATABASE_URL_OWNER ?? 'postgres://postgres:postgres@localhost:5432/lotline';

/** Authentication runs before there is an identity, so it uses a privileged connection. */
async function withAuthConnection<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ownerUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface LotlineToken {
  userId?: string;
  authEventId?: string;
}

export const authConfig: NextAuthConfig = {
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 12 * 60 * 60 },
  pages: { signIn: '/signin' },

  providers: [
    /**
     * Patterns 1 and 2: contractor staff on the home tenant, and client or
     * verifier users guested into it. A client agency that federates its own
     * issuer instead is routed by home-realm discovery to a per-organisation
     * provider registered at runtime, not to this one.
     */
    MicrosoftEntraID({
      clientId: process.env.AUTH_ENTRA_CLIENT_ID ?? '',
      clientSecret: process.env.AUTH_ENTRA_CLIENT_SECRET ?? '',
      ...(process.env.AUTH_ENTRA_ISSUER ? { issuer: process.env.AUTH_ENTRA_ISSUER } : {}),
      // The tenant is multi-tenant by design (ADR-0021): one app registration,
      // many contractor tenants.
      authorization: { params: { scope: 'openid profile email' } },
    }),

    /** Pattern 3: subcontractors and suppliers with no enterprise identity. */
    Credentials({
      id: 'local',
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        secondFactor: { label: 'Authenticator code', type: 'text' },
      },
      async authorize(raw) {
        const email = typeof raw?.email === 'string' ? raw.email : '';
        const password = typeof raw?.password === 'string' ? raw.password : '';
        const secondFactor = typeof raw?.secondFactor === 'string' ? raw.secondFactor : undefined;
        if (!email || !password) return null;

        return withAuthConnection(async (client) => {
          // Honour the stored pattern: a user migrated to a federated provider
          // must not be able to keep signing in with a retired local password.
          const pattern = await loadKnownPattern(client, email);
          if (pattern && pattern !== 'local_credentials') return null;

          const result = await authenticateWithPassword(client, {
            email, password, secondFactor,
          });
          if (!result.ok) return null;

          // Only these two fields reach the token. Everything authorisation
          // needs is derived server-side from the event.
          return { id: result.userId, authEventId: result.authEventId } as {
            id: string; authEventId: string;
          };
        });
      },
    }),
  ],

  callbacks: {
    /**
     * Records an authentication_event for the IdP paths, so every session —
     * however it was established — rests on a recorded event that the session
     * bridge can re-evaluate.
     */
    async jwt({ token, user, account }) {
      const t = token as typeof token & LotlineToken;
      if (user?.id) {
        t.userId = user.id;
        const fromCredentials = (user as { authEventId?: string }).authEventId;
        if (fromCredentials) {
          t.authEventId = fromCredentials;
        } else if (account) {
          t.authEventId = await withAuthConnection((client) =>
            recordAuthenticationEvent(client, {
              userId: user.id!,
              method: 'idp_primary',
              // Entra asserts MFA through the amr claim; absent it, we do not
              // claim MFA was satisfied. Under-claiming costs a step-up prompt,
              // over-claiming authorises a hold point release that should not
              // have happened.
              mfaSatisfied: hasMfaClaim(account),
              result: 'success',
            }));
        }
      }
      return t;
    },

    async session({ session, token }) {
      const t = token as typeof token & LotlineToken;
      return Object.assign(session, {
        userId: t.userId,
        authEventId: t.authEventId,
      });
    },
  },
};

function hasMfaClaim(account: unknown): boolean {
  const amr = (account as { amr?: unknown } | null)?.amr;
  if (Array.isArray(amr)) return amr.includes('mfa');
  return false;
}

/**
 * Which sign-in route an address should take. Used by the sign-in page so a
 * client agency lands on their own provider rather than being offered a
 * password box they do not have.
 */
export async function routeForEmail(email: string) {
  return withAuthConnection(async (client) => {
    const [routes, knownPattern] = await Promise.all([
      loadRealmRoutes(client),
      loadKnownPattern(client, email),
    ]);
    return resolveRealm(email, {
      routes,
      homeTenantDomains: (process.env.AUTH_HOME_TENANT_DOMAINS ?? '')
        .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
      knownPattern,
    });
  });
}
