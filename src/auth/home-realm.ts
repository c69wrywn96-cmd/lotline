/**
 * Home-realm discovery.
 *
 * An inbound email address decides which of the four authentication patterns
 * (ADR-0021) applies, and for federated users which identity provider to send
 * them to. Client agencies and independent verifiers federate their own issuer
 * rather than being guested into a contractor tenant, because their security
 * teams will not accept guesting.
 *
 * This module is pure: it takes the routing table and an address and returns a
 * decision. The lookup that builds the table lives in realm-lookup.ts, so this
 * logic is testable without a database.
 */

export type AuthPattern = 'home_tenant' | 'federated_oidc' | 'guest_b2b' | 'local_credentials';

export interface RealmRoute {
  /** Lower-cased email domain, e.g. "ardentsuper.com.au". */
  domain: string;
  organisationId: string;
  identityProviderId: string;
  issuer: string;
  protocol: 'oidc' | 'saml2';
  enforcesMfa: boolean;
}

export type RealmDecision =
  | { kind: 'federated'; route: RealmRoute }
  | { kind: 'home_tenant' }
  | { kind: 'local_credentials' }
  | { kind: 'unknown' };

/**
 * Extracts the domain, lower-cased. Returns null for anything that is not a
 * single-@ address — we route on a domain or we do not route at all, rather than
 * guessing at a malformed input.
 */
export function emailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  return domain.includes('.') ? domain : null;
}

export interface RealmInput {
  /** Active federated providers, keyed by the domains they claim. */
  routes: readonly RealmRoute[];
  /** Domains belonging to the platform's own Entra tenant(s). */
  homeTenantDomains: readonly string[];
  /**
   * The stored pattern for a known user. When present it WINS over domain
   * matching: a user who has been migrated to local credentials must not be
   * silently re-routed to an IdP because their employer later federated.
   */
  knownPattern?: AuthPattern | undefined;
}

export function resolveRealm(email: string, input: RealmInput): RealmDecision {
  const domain = emailDomain(email);
  if (!domain) return { kind: 'unknown' };

  const route = input.routes.find((r) => r.domain === domain);

  if (input.knownPattern) {
    switch (input.knownPattern) {
      case 'local_credentials':
        return { kind: 'local_credentials' };
      case 'home_tenant':
      case 'guest_b2b':
        return { kind: 'home_tenant' };
      case 'federated_oidc':
        // A user recorded as federated whose provider has since been suspended
        // must not silently fall back to a weaker pattern.
        return route ? { kind: 'federated', route } : { kind: 'unknown' };
    }
  }

  if (route) return { kind: 'federated', route };
  if (input.homeTenantDomains.includes(domain)) return { kind: 'home_tenant' };
  return { kind: 'unknown' };
}
