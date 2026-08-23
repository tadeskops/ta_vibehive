/**
 * ta_vibehive Cloudflare Worker — GitHub-backed source of truth.
 *
 * Flow per request:
 *   1. CORS preflight handling.
 *   2. Try to verify Google JWT (optional — anonymous is allowed for
 *      the health check and any explicitly public route).
 *   3. Resolve caller's role from `config/access.json`.
 *   4. Dispatch through the router.
 *   5. Convert HttpError to the JSON envelope; return.
 *
 * Secrets:
 *   TVH_ARCHIVE_PAT is a fine-grained PAT scoped to the archive repo
 *   only, held in Cloudflare Worker secret store (never in code, never
 *   sent to the browser).
 */

import type { Env } from './env.ts';
import type { Ctx } from './lib/ctx.ts';
import { err, ok, preflight } from './lib/envelope.ts';
import { HttpError } from './lib/errors.ts';
import { log } from './lib/log.ts';
import { verifyGoogleJwt } from './auth/jwt.ts';
import { resolveRole } from './auth/roles.ts';
import { loadAccess } from './config/loader.ts';
import { buildRouter } from './routes/index.ts';
import { flushPendingVisits } from './routes/metrics.ts';

const router = buildRouter();

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return preflight(env, req);

    if (url.pathname === '/' || url.pathname === '/healthz') {
      return ok(env, req, { ok: true, name: 'tvh-worker', version: '0.1.0' });
    }

    try {
      const identity = await verifyGoogleJwt(env, req).catch((e: unknown) => {
        if (e instanceof HttpError && e.status === 401) {
          const hasAuth = !!req.headers.get('Authorization');
          if (hasAuth) throw e;
          return undefined;
        }
        throw e;
      });

      const access = await loadAccess(env);
      const role = resolveRole(access, identity?.email ?? null);

      const ctx: Ctx = {
        env,
        req,
        url,
        role,
        ip: req.headers.get('CF-Connecting-IP') ?? '',
        ...(identity ? { identity } : {}),
      };

      const matched = router.match(req.method, url.pathname);
      if (!matched) return err(env, req, `Not found: ${req.method} ${url.pathname}`, 404);
      return await matched.handler(ctx, matched.params);
    } catch (e) {
      if (e instanceof HttpError) {
        log.warn(env, 'request_rejected', { status: e.status, msg: e.message, path: url.pathname });
        return err(env, req, e.message, e.status);
      }
      log.error(env, 'unhandled_error', { err: String((e as Error).stack ?? e), path: url.pathname });
      return err(env, req, 'Internal error', 500);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(flushPendingVisits(env).catch((e) => log.warn(env, 'cron_flush_visits_failed', { err: String(e) })));
  },
};
