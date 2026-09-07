/**
 * Resolving the current request's session.
 *
 * Placeholder for the Auth.js handler, which is the next piece of work. The
 * shape is already correct: a request carries a user id and an
 * authentication_event id, and buildSessionContext recomputes the strength from
 * the stored event rather than trusting anything the client sent.
 *
 * It is deliberately NOT possible for a caller to pass an authStrength in — the
 * whole authorisation model would then be in the hands of whoever can set a
 * cookie.
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SessionContext } from '../db/session';
import { buildSessionContext } from '../auth/session-bridge';

const ownerUrl =
  process.env.DATABASE_URL_OWNER ?? 'postgres://postgres:postgres@localhost:5432/lotline';

export class NotAuthenticated extends Error {
  constructor() { super('not authenticated'); this.name = 'NotAuthenticated'; }
}

export async function currentSession(): Promise<SessionContext> {
  const jar = await cookies();
  const hdrs = await headers();

  const userId = jar.get('lotline_uid')?.value;
  const authEventId = jar.get('lotline_auth_event')?.value;
  const deviceId = jar.get('lotline_device')?.value;
  if (!userId || !authEventId) throw new NotAuthenticated();

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return await buildSessionContext(client, {
      userId,
      authEventId,
      requestId: randomUUID(),
      ip: hdrs.get('x-forwarded-for')?.split(',')[0]?.trim(),
      userAgent: hdrs.get('user-agent') ?? undefined,
      deviceId,
    });
  } finally {
    await client.end();
  }
}
