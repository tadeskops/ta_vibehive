import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../env.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Google ID-token verification (Google Identity Services).
 * Reads the token from the `Authorization: Bearer <jwt>` header, verifies
 * the signature against Google's rotating JWKS, then checks `aud` matches
 * the configured OAuth client id.
 *
 * Returns { email, name, sub } on success. Throws HttpError(401) on any
 * failure. Callers that allow anonymous MUST catch and treat as public.
 */

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export interface Identity {
  email: string;
  name?: string;
  sub: string;
}

export async function verifyGoogleJwt(env: Env, req: Request): Promise<Identity> {
  const auth = req.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, 'Missing bearer token');
  const token = match[1].trim();
  if (!token) throw new HttpError(401, 'Empty token');

  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL));

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, jwks, {
      audience: env.GOOGLE_OAUTH_CLIENT_ID,
    });
    payload = result.payload as Record<string, unknown>;
  } catch (_e) {
    throw new HttpError(401, 'Invalid or expired token');
  }

  const iss = String(payload['iss'] || '');
  if (!ISSUERS.has(iss)) throw new HttpError(401, 'Untrusted issuer');
  const emailVerified = payload['email_verified'];
  if (emailVerified === false) throw new HttpError(401, 'Email not verified');
  const email = String(payload['email'] || '').toLowerCase();
  if (!email) throw new HttpError(401, 'Token missing email');
  const sub = String(payload['sub'] || '');
  const name = payload['name'] ? String(payload['name']) : undefined;
  return { email, sub, ...(name ? { name } : {}) };
}
