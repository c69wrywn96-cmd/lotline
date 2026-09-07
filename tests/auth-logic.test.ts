/**
 * Home-realm discovery and authentication-strength derivation.
 *
 * Pure logic, tested without a browser, an IdP or a server: these rules decide
 * who may release a hold point, and "we clicked around and it seemed fine" is
 * not evidence.
 */
import { describe, it, expect } from 'vitest';
import { emailDomain, resolveRealm, type RealmRoute } from '../src/auth/home-realm';
import {
  deriveStrength, satisfies, STEP_UP_TTL_SECONDS, DEVICE_UNLOCK_TTL_SECONDS,
} from '../src/auth/strength';

const ardent: RealmRoute = {
  domain: 'ardentsuper.com.au',
  organisationId: 'org-super',
  identityProviderId: 'idp-super',
  issuer: 'https://login.microsoftonline.com/ardent-super/v2.0',
  protocol: 'oidc',
  enforcesMfa: true,
};
const base = { routes: [ardent], homeTenantDomains: ['northboundcivil.com.au'] };

describe('email domain extraction', () => {
  it('lower-cases and takes the domain', () => {
    expect(emailDomain('K.Ferreira@ArdentSuper.com.au')).toBe('ardentsuper.com.au');
  });

  it('refuses to guess at malformed input rather than routing on a guess', () => {
    for (const bad of ['', 'nobody', '@example.com', 'a@', 'a@b@c.com', 'a@localhost', '   ']) {
      expect(emailDomain(bad), bad).toBeNull();
    }
  });
});

describe('home-realm discovery', () => {
  it('routes a client agency to their own issuer, not a guest invitation', () => {
    const d = resolveRealm('k.ferreira@ardentsuper.com.au', base);
    expect(d).toEqual({ kind: 'federated', route: ardent });
  });

  it('routes contractor staff to the home tenant', () => {
    expect(resolveRealm('p.nandakumar@northboundcivil.com.au', base)).toEqual({ kind: 'home_tenant' });
  });

  it('an unrecognised domain is unknown — it does not fall through to a weaker pattern', () => {
    expect(resolveRealm('someone@example.org', base)).toEqual({ kind: 'unknown' });
  });

  it('a known local-credentials user is not re-routed when their employer federates later', () => {
    // Vellacott sign in with a password and TOTP. If their domain were later
    // claimed by an IdP, silently switching them would lock them out of their
    // own account.
    const withSubDomain = {
      ...base,
      routes: [...base.routes, { ...ardent, domain: 'vellacott.com.au' }],
    };
    const d = resolveRealm('t.vellacott@vellacott.com.au', {
      ...withSubDomain,
      knownPattern: 'local_credentials',
    });
    expect(d).toEqual({ kind: 'local_credentials' });
  });

  it('a federated user whose provider is gone fails closed, not down a weaker path', () => {
    const d = resolveRealm('k.ferreira@ardentsuper.com.au', {
      routes: [],                 // provider suspended
      homeTenantDomains: ['ardentsuper.com.au'],  // and the domain now looks internal
      knownPattern: 'federated_oidc',
    });
    expect(d).toEqual({ kind: 'unknown' });
  });
});

describe('authentication strength derivation', () => {
  const now = { ageSeconds: 0, deviceBound: false };

  it('a fresh re-authentication is step-up', () => {
    expect(deriveStrength({ method: 'idp_reauth', mfaSatisfied: true, ...now })).toBe('step_up');
  });

  it('step-up decays — 7am does not authorise a 4pm hold point release', () => {
    expect(
      deriveStrength({ method: 'idp_reauth', mfaSatisfied: true, ageSeconds: STEP_UP_TTL_SECONDS + 1, deviceBound: false }),
    ).toBe('device_unlock');
  });

  it('a full IdP session with MFA is step-up while fresh, then a device unlock', () => {
    expect(deriveStrength({ method: 'idp_primary', mfaSatisfied: true, ...now })).toBe('step_up');
    expect(
      deriveStrength({ method: 'idp_primary', mfaSatisfied: true, ageSeconds: 3600, deviceBound: false }),
    ).toBe('device_unlock');
  });

  it('an IdP session WITHOUT MFA never reaches step-up', () => {
    expect(deriveStrength({ method: 'idp_primary', mfaSatisfied: false, ...now })).toBe('device_unlock');
  });

  it('a device PIN is an unlock and never a step-up, however fresh', () => {
    expect(deriveStrength({ method: 'device_pin', mfaSatisfied: true, ageSeconds: 0, deviceBound: true }))
      .toBe('device_unlock');
  });

  it('a platform passkey on a shared device IS a step-up — that is the point of preferring it', () => {
    expect(deriveStrength({ method: 'device_passkey', mfaSatisfied: true, ageSeconds: 0, deviceBound: true }))
      .toBe('step_up');
  });

  it('a recovery code buys a session back and nothing more', () => {
    expect(deriveStrength({ method: 'recovery_code', mfaSatisfied: true, ...now })).toBe('session');
  });

  it('a shared tablet decays faster than a personal device', () => {
    const age = DEVICE_UNLOCK_TTL_SECONDS / 2;
    expect(deriveStrength({ method: 'device_pin', mfaSatisfied: true, ageSeconds: age, deviceBound: true }))
      .toBe('session');
    expect(deriveStrength({ method: 'idp_primary', mfaSatisfied: false, ageSeconds: age, deviceBound: false }))
      .toBe('device_unlock');
  });

  it('an expired unlock falls to session, never to nothing and never to more', () => {
    expect(
      deriveStrength({ method: 'device_pin', mfaSatisfied: true, ageSeconds: DEVICE_UNLOCK_TTL_SECONDS * 10, deviceBound: false }),
    ).toBe('session');
  });
});

describe('strength comparison', () => {
  it('orders session < device_unlock < step_up', () => {
    expect(satisfies('step_up', 'device_unlock')).toBe(true);
    expect(satisfies('device_unlock', 'step_up')).toBe(false);
    expect(satisfies('session', 'session')).toBe(true);
    expect(satisfies('device_unlock', 'session')).toBe(true);
  });
});
