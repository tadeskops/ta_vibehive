import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson, listDir } from '../github/client.ts';
import { atLeast } from '../auth/roles.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Event storage layout in the archive repo:
 *   events/{slug}/event.json
 *
 * The `slug` is the caller-supplied path component; we sanitise it to
 * a filesystem-safe form. Full event JSON is the single source of
 * truth per event.
 */

interface EventDoc extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  status: string;
  updated_at?: string;
  updated_by?: string;
  created_at?: string;
  created_by?: string;
}

function sanitizeSlug(v: string): string {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function pathFor(slug: string): string {
  const s = sanitizeSlug(slug);
  if (!s) throw new HttpError(400, 'Invalid event slug');
  return `events/${s}/event.json`;
}

/**
 * GET /events
 * Returns every event as an array. Filtered by role:
 *   - anonymous / resident: only `published` and `closed`
 *   - committee+: all statuses
 *
 * Robustness (2026-08-24):
 *   - Isolate-local cache with a short TTL keeps the endpoint under
 *     the free-plan subrequest / CPU limits when the archive grows to
 *     dozens of events. A cold isolate still pays the full fan-out
 *     cost once, but every subsequent request in that isolate for
 *     TTL_MS returns instantly.
 *   - Any GitHub / network failure is caught and swallowed: we degrade
 *     to whatever we already have cached (possibly empty). Anonymous
 *     visitors never see a Cloudflare 1102 / 5xx here — a bad
 *     retrieval is indistinguishable from "no events yet" from the
 *     frontend's perspective, which is the correct fallback for a
 *     public read.
 */
const LIST_CACHE_TTL_MS = 30_000;
let _listCache: { at: number; events: EventDoc[] } | null = null;

async function loadAllEvents(env: Ctx['env']): Promise<EventDoc[]> {
  const now = Date.now();
  if (_listCache && now - _listCache.at < LIST_CACHE_TTL_MS) {
    return _listCache.events;
  }
  const events: EventDoc[] = [];
  try {
    const entries = await listDir(env, 'events');
    const dirs = entries.filter((e) => e.type === 'dir');
    const settled = await Promise.allSettled(
      dirs.map((dir) => readJson<EventDoc>(env, `${dir.path}/event.json`)),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value && r.value.data) events.push(r.value.data);
    }
    _listCache = { at: now, events };
  } catch (_e) {
    if (_listCache) return _listCache.events;
    return [];
  }
  return events;
}

export async function listEvents(ctx: Ctx): Promise<Response> {
  let events: EventDoc[] = [];
  try {
    events = await loadAllEvents(ctx.env);
  } catch (_e) {
    events = [];
  }
  const canSeeAll = atLeast(ctx.role, 'committee');
  const visible = canSeeAll
    ? events
    : events.filter((e) => e.status === 'published' || e.status === 'closed');
  return ok(ctx.env, ctx.req, { events: visible });
}

/**
 * GET /events/:slug
 * Returns the event document + current sha (for optimistic locking on save).
 */
export async function getEvent(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  const path = pathFor(params['slug']);
  const doc = await readJson<EventDoc>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Not found', 404);
  const canSee = atLeast(ctx.role, 'committee')
    || doc.data.status === 'published'
    || doc.data.status === 'closed';
  if (!canSee) return err(ctx.env, ctx.req, 'Not visible with your role', 403);
  return ok(ctx.env, ctx.req, { event: doc.data, sha: doc.sha });
}

/**
 * PUT /events/:slug
 * Committee+ only. Body: { event: EventDoc, expectedSha?: string }.
 * On successful write, updates `updated_by` and `updated_at` server-side
 * so the caller cannot forge attribution. Returns new sha for chaining.
 */
export async function putEvent(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  /* Distinguish an expired-token caller (401) from a signed-in caller
   * whose role is genuinely too low (403). Without the 401 branch the
   * frontend's silent-refresh + retry logic can't recover, and admins
   * whose Google JWT lapsed see a confusing "Committee or above
   * required" instead of "Sign in required". */
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const path = pathFor(params['slug']);
  let body: { event?: EventDoc; expectedSha?: string };
  try { body = await ctx.req.json(); } catch (_e) { return err(ctx.env, ctx.req, 'Invalid JSON body', 400); }
  const event = body.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return err(ctx.env, ctx.req, '`event` must be an object', 400);
  }
  if (!event.id || !event.title) return err(ctx.env, ctx.req, 'event.id and event.title are required', 400);
  const stamped: EventDoc = {
    ...event,
    slug: sanitizeSlug(params['slug']),
    updated_at: new Date().toISOString(),
    updated_by: ctx.identity?.email ?? 'unknown',
    created_at: event.created_at || new Date().toISOString(),
    created_by: event.created_by || (ctx.identity?.email ?? 'unknown'),
  };
  const message = `event: ${stamped.slug} ${stamped.status || 'draft'} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, stamped, message, body.expectedSha);
    _listCache = null;
    return ok(ctx.env, ctx.req, { event: stamped, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}
