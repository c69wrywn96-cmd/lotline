-- 0020 — TOTP replay prevention and credential lockout state.
--
-- A TOTP code is valid for a whole step (30s), and the verifier accepts a window
-- either side of it. Without recording which counter was consumed, a code
-- observed over someone's shoulder — or replayed from a proxy — works again for
-- the rest of its window. Recording the highest counter used closes that.

ALTER TABLE auth_totp ADD COLUMN last_used_counter bigint;
COMMENT ON COLUMN auth_totp.last_used_counter IS
  'Highest TOTP counter consumed. A code at or below this is refused, so a code cannot be replayed within its validity window.';

-- Lockout is per credential and already has failed_attempts / locked_until.
-- Recovery codes are single use: consuming one removes its hash from the array,
-- so a stolen list shrinks as it is used rather than remaining valid.
COMMENT ON COLUMN auth_totp.recovery_code_hashes IS
  'Single-use. A consumed code is removed from the array; the list is not regenerated implicitly.';

-- Authentication runs BEFORE there is an identity, so it cannot use the
-- user-scoped connection: auth.user_id() is null there and every table reads
-- empty. These tables therefore have RLS enabled with NO permissive policy at
-- all, and are reached only by the privileged authentication path.
COMMENT ON TABLE auth_credential IS
  'Local password credentials. RLS enabled with no permissive policy: unreachable through the ordinary data path, by anyone. Read only by the authentication service on a privileged connection.';
COMMENT ON TABLE auth_totp IS
  'TOTP enrolment. RLS enabled with no permissive policy, for the same reason as auth_credential.';
