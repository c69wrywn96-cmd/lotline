/**
 * Resolving the current request's session.
 *
 * Auth.js establishes WHO the caller is and which authentication_event the
 * session rests on. Everything authorisation depends on — the strength, the
 * device binding — is then recomputed from that stored event by
 * buildSessionContext, on every request.
 *
 * That split is the point. The token carries a user id and an event id and
 * nothing else; if it carried the strength, anyone able to set a cookie could
 * assert `step_up` and release a hold point.
 */
import 'server-only';
import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SessionContext } from '../db/session';
import { buildSessionContext, SessionRejected } from '../auth/session-bridge';
import { auth } from '../auth/index';

const ownerUrl = () =>
  process.env.DATABASE_URL_OWNER ?? 'postgres://postgres:postgres@localhost:5432/lotline';

export class NotAuthenticated extends Error {
  readonly reason: unknown;
  constructor(reason?: unknown) {
    super('not authenticated');
    this.name = 'NotAuthenticated';
    this.reason = reason;
  }
}

export async function currentSession(): Promise<SessionContext> {
  const session = (await auth()) as
    | { userId?: string; authEventId?: string }
    | null;
  if (!session?.userId || !session.authEventId) throw new NotAuthenticated();

  const hdrs = await headers();
  const jar = await cookies();
  // The device id is a first-party cookie set at device unlock. It is only ever
  // a hint: buildSessionContext verifies the device is still trusted and that
  // this user is actually enrolled on it, and refuses otherwise.
  const deviceId = jar.get('lotline_device')?.value;

  const client = new pg.Client({ connectionString: ownerUrl() });
  await client.connect();
  try {
    return await buildSessionContext(client, {
      userId: session.userId,
      authEventId: session.authEventId,
      requestId: randomUUID(),
      ip: hdrs.get('x-forwarded-for')?.split(',')[0]?.trim(),
      userAgent: hdrs.get('user-agent') ?? undefined,
      deviceId,
    });
  } catch (err) {
    // A revoked device or a superseded event ends the session immediately,
    // rather than being treated as a transient error.
    if (err instanceof SessionRejected) throw new NotAuthenticated(err);
    throw err;
  } finally {
    await client.end();
  }
}
