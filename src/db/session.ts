/**
 * Session-bound database access.
 *
 * Every request runs inside ONE transaction that begins by setting
 * transaction-local GUCs carrying the caller's identity. RLS policies read those
 * GUCs; if they are unset, auth.user_id() is NULL, every policy predicate is
 * false, and every table reads as empty. Fail closed.
 *
 * SET LOCAL (not SET) is load-bearing. With a connection pooler a session-scoped
 * SET leaks one user's identity into the next request that borrows the
 * connection. There is deliberately no API here that yields a connection outside
 * a transaction — `withSession` is the only door.
 */
import pg from 'pg';

export interface SessionContext {
  /** The authenticated user. Required: there is no anonymous data path. */
  userId: string;
  /** Correlates every audit row written by this request. */
  requestId?: string;
  ip?: string;
  userAgent?: string;
  /** Present when the request comes from an enrolled device. */
  deviceId?: string;
  /** The authentication_event that authorised this session (ADR-0021). */
  authEventId?: string;
  /**
   * How strongly this session authenticated. Drives the §10 authentication
   * floor: a hold point release needs step-up, a photo upload does not.
   * Defaults to the weakest level, so an unset value can never over-authorise.
   */
  authStrength?: 'session' | 'device_unlock' | 'step_up';
  /**
   * True when the session runs on a shared, enrolled site device. Such a
   * session is capability-restricted regardless of the user's role: no role
   * management, no exports, no API keys.
   */
  deviceBound?: boolean;
}

export type SessionClient = {
  query: <R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ) => Promise<pg.QueryResult<R>>;
};

export class Database {
  readonly #pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.#pool = new pg.Pool({ connectionString, max });
  }

  /**
   * Run `fn` inside a transaction bound to `ctx`. Commits on return, rolls back
   * on throw. The client handed to `fn` is only valid for that call.
   */
  async withSession<T>(ctx: SessionContext, fn: (db: SessionClient) => Promise<T>): Promise<T> {
    if (!ctx.userId) {
      throw new Error('withSession requires a userId — there is no anonymous data path');
    }
    const conn = await this.#pool.connect();
    try {
      await conn.query('BEGIN');
      // `true` == SET LOCAL semantics: these die with the transaction.
      await conn.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.request_id', $2, true),
                set_config('app.ip', $3, true),
                set_config('app.user_agent', $4, true),
                set_config('app.device_id', $5, true),
                set_config('app.auth_event_id', $6, true),
                set_config('app.auth_strength', $7, true),
                set_config('app.device_bound', $8, true)`,
        [
          ctx.userId,
          ctx.requestId ?? '',
          ctx.ip ?? '',
          ctx.userAgent ?? '',
          ctx.deviceId ?? '',
          ctx.authEventId ?? '',
          ctx.authStrength ?? 'session',
          String(ctx.deviceBound ?? false),
        ],
      );
      const result = await fn({
        query: (text, params) => conn.query(text, params as unknown[]),
      });
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }

  async end(): Promise<void> {
    await this.#pool.end();
  }
}

/** Postgres error codes the application maps to user-facing outcomes. */
export const PG_ERROR = {
  /** RLS WITH CHECK violation — the row is visible but outside write scope. */
  INSUFFICIENT_PRIVILEGE: '42501',
  CHECK_VIOLATION: '23514',
  UNIQUE_VIOLATION: '23505',
  RAISE_EXCEPTION: 'P0001',
} as const;

/**
 * Distinguishes "outside your assigned sections" from "not found".
 *
 * This distinction is the JV mechanism (ADR-0020): a partner may SEE a row in
 * another partner's zone and cannot write it. Postgres reports the failed
 * WITH CHECK as 42501, which we surface honestly rather than pretending the row
 * does not exist — because it does, and the user can see it.
 */
export function isWriteScopeViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_ERROR.INSUFFICIENT_PRIVILEGE
  );
}

export function lotlineErrorCode(err: unknown): string | null {
  const message = (err as { message?: string } | null)?.message ?? '';
  const match = /LOTLINE_[A-Z_]+/.exec(message);
  return match ? match[0] : null;
}
