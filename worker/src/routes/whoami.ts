import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';

/**
 * GET /whoami
 * Returns the caller's verified identity + resolved role. Useful for
 * the browser to hydrate the session (name/email/role) without
 * decoding the JWT again.
 */
export async function whoami(ctx: Ctx): Promise<Response> {
  if (!ctx.identity) return err(ctx.env, ctx.req, 'Not signed in', 401);
  return ok(ctx.env, ctx.req, {
    email: ctx.identity.email,
    name: ctx.identity.name || ctx.identity.email.split('@')[0],
    role: ctx.role,
  });
}
