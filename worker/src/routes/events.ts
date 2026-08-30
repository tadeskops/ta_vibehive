import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson, writeBinary, readBinaryBase64, listDir, deleteFile } from '../github/client.ts';
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

/** Reverse of the mime->ext mapping used when archiving a QR image. */
function mimeForExt(ext: string): string {
  const e = String(ext || '').toLowerCase();
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  return 'application/octet-stream';
}
function extForMime(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  return 'bin';
}

/**
 * Persists the event's payment QR (if any) as a separate binary file
 * at `events/{slug}/qr.{ext}` instead of inline in event.json. A
 * ~400KB base64 QR embedded per event was exactly the anti-pattern
 * that made every /events bulk read (loadAllEvents) decode+parse
 * hundreds of KB it never needed just to list titles/status — the
 * same CF-1102 CPU-limit cause fixed for contribution proofs.
 * Failures are swallowed; the JSON write is the source of truth and
 * a missing binary parallel-write must never break event save. */
async function archiveEventQr(env: Ctx['env'], slug: string, dataUrl: string): Promise<string | null> {
  const m = String(dataUrl || '').match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
  if (!m) return null;
  const mime = m[1] || 'image/png';
  const b64 = m[2] || '';
  if (!b64) return null;
  const path = `events/${sanitizeSlug(slug)}/qr.${extForMime(mime)}`;
  try {
    await writeBinary(env, path, b64, `event: archive payment QR for ${slug}`);
    return path;
  } catch (_e) {
    return null;
  }
}

/**
 * GET /events
 * Returns every event as an array. Filtered by role:
 *   - anonymous / resident: only `published` and `closed`
 *   - committee+: all statuses
 *
 * Sequential read pattern (mirrors listExpenses) — no isolate cache,
 * no fan-out, no retries. Any earlier layers of retry/union-fallback
 * logic were patching symptoms of an intermittent bug the sequential
 * pattern doesn't have in the first place. "Simple + always correct"
 * beats "fast + sometimes drops records".
 */

async function loadAllEvents(env: Ctx['env']): Promise<EventDoc[]> {
  const events: EventDoc[] = [];
  let entries;
  try { entries = await listDir(env, 'events'); }
  catch (_e) { return events; }
  for (const dir of entries) {
    if (dir.type !== 'dir') continue;
    try {
      const doc = await readJson<EventDoc>(env, `${dir.path}/event.json`);
      if (doc && doc.data) events.push(doc.data);
    } catch (_e) { /* one bad file must not tank the whole list */ }
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
 * GET /events/:slug/qr
 * Returns the event's payment QR as a data URL, read from the
 * dedicated binary path rather than the JSON record — bulk
 * list reads never have to decode it this way. Same visibility as
 * the event itself.
 */
export async function getEventQr(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  const path = pathFor(params['slug']);
  const doc = await readJson<EventDoc>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Not found', 404);
  const canSee = atLeast(ctx.role, 'committee')
    || doc.data.status === 'published'
    || doc.data.status === 'closed';
  if (!canSee) return err(ctx.env, ctx.req, 'Not visible with your role', 403);
  /* Legacy events written before this fix still carry the QR inline —
   * serve it straight from the JSON rather than 404ing. */
  const inline = String((doc.data as Record<string, unknown>)['payment_qr_data_url'] || '');
  if (inline) return ok(ctx.env, ctx.req, { qr_data_url: inline });
  const archivePath = String((doc.data as Record<string, unknown>)['payment_qr_archive_path'] || '');
  if (!archivePath) return err(ctx.env, ctx.req, 'No QR attached', 404);
  const bin = await readBinaryBase64(ctx.env, archivePath);
  if (!bin) return err(ctx.env, ctx.req, 'QR file not found', 404);
  const ext = archivePath.split('.').pop() || '';
  return ok(ctx.env, ctx.req, { qr_data_url: `data:${mimeForExt(ext)};base64,${bin.base64}` });
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
    const qrDataUrl = String((stamped as Record<string, unknown>)['payment_qr_data_url'] || '');
    /* Persist the lean record only. A new/changed QR gets archived to
     * its own binary file; the inline copy is dropped before writing
     * so bulk /events reads never have to decode it (see
     * archiveEventQr comment). An empty qrDataUrl means "no QR" or
     * "admin removed it" — either way there's nothing to archive and
     * the field is already absent from `toStore`. */
    const toStore: EventDoc = { ...stamped };
    if (qrDataUrl) {
      const archivePath = await archiveEventQr(ctx.env, stamped.slug, qrDataUrl);
      if (archivePath) {
        (stamped as Record<string, unknown>)['payment_qr_archive_path'] = archivePath;
        (toStore as Record<string, unknown>)['payment_qr_archive_path'] = archivePath;
        delete (toStore as Record<string, unknown>)['payment_qr_data_url'];
      }
    } else {
      delete (toStore as Record<string, unknown>)['payment_qr_data_url'];
    }
    const result = await writeJson(ctx.env, path, toStore, message, body.expectedSha);
    return ok(ctx.env, ctx.req, { event: stamped, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * DELETE /events/:slug
 * Admin-only. Removes the event.json (contributions and expenses are
 * left in place so audit history survives). Idempotent — a missing
 * file returns `{ deleted: false }`.
 */
export async function deleteEvent(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'admin')) return err(ctx.env, ctx.req, 'Admin only', 403);
  const path = pathFor(params['slug']);
  const message = `event: deleted ${sanitizeSlug(params['slug'])} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await deleteFile(ctx.env, path, message);
    return ok(ctx.env, ctx.req, { deleted: !!result, path });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}
