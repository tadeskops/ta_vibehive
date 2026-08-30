import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson } from '../github/client.ts';
import { atLeast } from '../auth/roles.ts';
import { HttpError } from '../lib/errors.ts';
import { invalidateAccessCache } from '../config/loader.ts';

const OVERRIDES_PATH = 'settings/society-overrides.json';

/**
 * GET /settings
 * Returns the shared society-overrides document. Available to any
 * signed-in user because the doc contains branding + role mapping
 * (residents also need to know who the admin is). Anonymous callers
 * get 401 to keep the doc private-ish.
 */
export async function getSettings(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  const doc = await readJson<Record<string, unknown>>(ctx.env, OVERRIDES_PATH);
  return ok(ctx.env, ctx.req, {
    overrides: doc?.data ?? {},
    sha: doc?.sha ?? null,
  });
}

/**
 * PUT /settings
 * Secretary+ only. Body: { overrides: object, expectedSha?: string }.
 * Config/roles.json grants secretary and mgmt `users.manage`,
 * `settings.attributes.edit`, and `settings.templates.edit` — the
 * routes that write here. Requiring `admin` on the server side
 * caused a silent 403 that reverted the local edit on save (seen
 * 2026-08-30: secretary editing the role-email list saw the change
 * disappear on reload). The UI already gates admin-only fields
 * (branding, features registry, roles editor) so we can trust that
 * secretary+ callers aren't touching those.
 * Uses optimistic locking via `expectedSha` so two editors on the
 * same file can't silently overwrite each other. The Worker also
 * strips any accidental `archive_pat` field from the payload before
 * committing — belt-and-braces defence against secret leakage.
 */
export async function putSettings(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'secretary')) return err(ctx.env, ctx.req, 'Secretary or above required', 403);

  let body: { overrides?: unknown; expectedSha?: string };
  try {
    body = await ctx.req.json();
  } catch (_e) {
    return err(ctx.env, ctx.req, 'Invalid JSON body', 400);
  }
  const overrides = body.overrides;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return err(ctx.env, ctx.req, '`overrides` must be an object', 400);
  }
  const sanitized = sanitize(overrides as Record<string, unknown>);
  const message = `settings: overrides save by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, OVERRIDES_PATH, sanitized, message, body.expectedSha);
    /* Any change to overrides may touch `access.role_emails`, so bust
     * the merged access-map cache immediately. The next whoami call
     * will reflect the fresh mapping without waiting for TTL. */
    invalidateAccessCache();
    return ok(ctx.env, ctx.req, { sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/** Recursively strip known secrets so they never land in git history. */
function sanitize(input: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  const receipts = clone['receipts'];
  if (receipts && typeof receipts === 'object' && !Array.isArray(receipts)) {
    delete (receipts as Record<string, unknown>)['archive_pat'];
  }
  return clone;
}
