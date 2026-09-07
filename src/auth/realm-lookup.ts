/**
 * Builds the home-realm routing table from the database.
 *
 * Separated from the routing logic in home-realm.ts so that logic stays pure and
 * testable; this file is the only part that needs a connection.
 */
import pg from 'pg';
import type { AuthPattern, RealmRoute } from './home-realm';

/**
 * Reads active federated providers. Runs on a privileged connection, NOT a
 * user session: home-realm discovery happens before anyone is authenticated, so
 * there is no identity to scope it by. That is also why org_identity_provider
 * has no permissive RLS policy for the application role — nothing reads it
 * through the ordinary data path.
 */
export async function loadRealmRoutes(client: pg.Client | pg.PoolClient): Promise<RealmRoute[]> {
  const { rows } = await client.query<{
    domain: string; organisation_id: string; id: string;
    issuer: string; protocol: 'oidc' | 'saml2'; enforces_mfa: boolean;
  }>(
    `SELECT lower(d) AS domain, organisation_id, id, issuer, protocol, enforces_mfa
       FROM org_identity_provider, unnest(allowed_email_domains) AS d
      WHERE status = 'active'`,
  );
  return rows.map((r) => ({
    domain: r.domain,
    organisationId: r.organisation_id,
    identityProviderId: r.id,
    issuer: r.issuer,
    protocol: r.protocol,
    enforcesMfa: r.enforces_mfa,
  }));
}

/**
 * The pattern recorded against a known user, or undefined for an address we do
 * not recognise. Returning undefined rather than throwing matters: the sign-in
 * form must behave identically for a known and an unknown address, or it becomes
 * an account-enumeration oracle.
 */
export async function loadKnownPattern(
  client: pg.Client | pg.PoolClient,
  email: string,
): Promise<AuthPattern | undefined> {
  const { rows } = await client.query<{ auth_pattern: AuthPattern }>(
    `SELECT auth_pattern FROM user_account
      WHERE email = $1 AND status = 'active' AND superseded_by_id IS NULL`,
    [email],
  );
  return rows[0]?.auth_pattern;
}
