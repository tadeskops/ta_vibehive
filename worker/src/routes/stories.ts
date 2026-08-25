import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson, writeBinary, listDir, deleteFile } from '../github/client.ts';
import { atLeast } from '../auth/roles.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Instagram-style dashboard stories for community announcements.
 *
 * Storage layout in the archive repo:
 *   stories/{YYYY}/{MM}/{storyId}.json    metadata + thumb data URL
 *   stories/{YYYY}/{MM}/{storyId}.{ext}   full-res image binary (optional)
 *
 * The list endpoint returns thumbnails only (~3-5 KB WebP each) so the
 * boot-sync payload stays tiny even with many active stories. The
 * fullscreen viewer fetches the individual story JSON on tap for the
 * full-res `image_data_url` and CTA fields.
 */
interface Story extends Record<string, unknown> {
  id: string;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
  created_by: string;
  expires_at: string;
  thumb_data_url: string;
  image_data_url?: string;
  cta_kind?: 'whatsapp' | 'tel' | 'link';
  cta_label?: string;
  cta_value?: string;
  cta_prefill?: string;
  duration_ms?: number;
  archived_at?: string;
  archived_by?: string;
}

function newId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(36))
    .join('');
  return `s-${Date.now().toString(36)}-${rand}`;
}

function pathFor(id: string, createdAt?: string): string {
  const d = createdAt ? new Date(createdAt) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const safe = String(id || '').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 60);
  return `stories/${y}/${m}/${safe}.json`;
}

function extForMime(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return 'bin';
}

const LIST_CACHE_TTL_MS = 30_000;
let _listCache: { at: number; stories: Story[] } | null = null;

function invalidateStoryCache(): void { _listCache = null; }

async function loadAllStories(env: Ctx['env']): Promise<Story[]> {
  const nowT = Date.now();
  if (_listCache && nowT - _listCache.at < LIST_CACHE_TTL_MS) return _listCache.stories;
  const now = new Date();
  const months: Array<{ y: number; m: string }> = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ y: d.getUTCFullYear(), m: String(d.getUTCMonth() + 1).padStart(2, '0') });
  }
  try {
    const dirSettled = await Promise.allSettled(
      months.map(({ y, m }) => listDir(env, `stories/${y}/${m}`)),
    );
    const files: string[] = [];
    for (const r of dirSettled) {
      if (r.status !== 'fulfilled') continue;
      for (const e of r.value) {
        if (e.type === 'file' && e.name.endsWith('.json')) files.push(e.path);
      }
    }
    const fileSettled = await Promise.allSettled(files.map((p) => readJson<Story>(env, p)));
    const out: Story[] = [];
    for (const r of fileSettled) {
      if (r.status === 'fulfilled' && r.value && r.value.data) out.push(r.value.data);
    }
    _listCache = { at: nowT, stories: out };
    return out;
  } catch (_e) {
    if (_listCache) return _listCache.stories;
    return [];
  }
}

// List endpoint returns thumbnails only; the fullscreen viewer fetches
// individual stories for the heavy `image_data_url` field.
function stripFullImage(s: Story): Story {
  const out: Story = { ...s };
  delete out['image_data_url'];
  return out;
}

/**
 * GET /stories
 * Returns active, non-expired stories with thumbs only. Committee+ also
 * sees archived stories (for the management view) via `?include=archived`.
 * Anonymous callers see nothing (401).
 */
export async function listStories(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  const includeArchived = ctx.url.searchParams.get('include') === 'archived'
    && atLeast(ctx.role, 'committee');
  const nowIso = new Date().toISOString();
  const all = await loadAllStories(ctx.env);
  const out: Story[] = [];
  for (const s of all) {
    if (!includeArchived) {
      if (s.status !== 'active') continue;
      if (s.expires_at && s.expires_at <= nowIso) continue;
    }
    out.push(stripFullImage(s));
  }
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return ok(ctx.env, ctx.req, { stories: out });
}

/**
 * GET /stories/:year/:month/:id
 * Returns the full story record including `image_data_url`.
 */
export async function readStory(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  const { year, month, id } = params;
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `stories/${year}/${month}/${id}.json`;
  const doc = await readJson<Story>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Story not found', 404);
  const s = doc.data;
  if (s.status !== 'active' && !atLeast(ctx.role, 'committee')) {
    return err(ctx.env, ctx.req, 'Story not found', 404);
  }
  const nowIso = new Date().toISOString();
  if (s.expires_at && s.expires_at <= nowIso && !atLeast(ctx.role, 'committee')) {
    return err(ctx.env, ctx.req, 'Story has expired', 410);
  }
  return ok(ctx.env, ctx.req, { story: s, sha: doc.sha });
}

function parseDataUrl(dataUrl: string): { mime: string; b64: string } | null {
  const m = String(dataUrl || '').match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
  if (!m) return null;
  return { mime: m[1] || 'application/octet-stream', b64: m[2] || '' };
}

async function archiveImageBinary(ctx: Ctx, story: Story): Promise<string | null> {
  const parsed = parseDataUrl(String(story.image_data_url || ''));
  if (!parsed || !parsed.b64) return null;
  const y = new Date(String(story.created_at || new Date().toISOString())).getUTCFullYear();
  const m = String(new Date(String(story.created_at || new Date().toISOString())).getUTCMonth() + 1).padStart(2, '0');
  const path = `stories/${y}/${m}/${String(story.id).replace(/[^a-z0-9_.-]+/gi, '-')}.${extForMime(parsed.mime)}`;
  const message = `story: archive binary for ${story.id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    await writeBinary(ctx.env, path, parsed.b64, message);
    return path;
  } catch (_e) {
    return null;
  }
}

/**
 * POST /stories
 * Body: { story: { title, thumb_data_url, image_data_url, cta_*, expires_at, duration_ms } }
 * Committee+ only. Rejects payloads over 1.5 MB combined (guard against
 * accidental huge uploads eating the free-plan write budget).
 */
export async function createStory(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  let body: { story?: Partial<Story> };
  try { body = await ctx.req.json(); } catch (_e) { return err(ctx.env, ctx.req, 'Invalid JSON body', 400); }
  const draft = body.story;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return err(ctx.env, ctx.req, '`story` must be an object', 400);
  }
  const title = String(draft.title || '').trim();
  const thumb = String(draft.thumb_data_url || '');
  const expiresAt = String(draft.expires_at || '');
  if (!title) return err(ctx.env, ctx.req, 'title is required', 400);
  if (!thumb || !thumb.startsWith('data:image/')) return err(ctx.env, ctx.req, 'thumb_data_url is required (data:image/...)', 400);
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return err(ctx.env, ctx.req, 'expires_at must be an ISO date', 400);
  if (Date.parse(expiresAt) <= Date.now()) return err(ctx.env, ctx.req, 'expires_at must be in the future', 400);
  const imageSize = String(draft.image_data_url || '').length + thumb.length;
  if (imageSize > 1_800_000) return err(ctx.env, ctx.req, 'Story image is too large. Please compress before upload.', 413);
  const nowIso = new Date().toISOString();
  const stamped: Story = {
    id: newId(),
    title,
    status: 'active',
    created_at: nowIso,
    created_by: ctx.identity?.email ?? 'unknown',
    expires_at: expiresAt,
    thumb_data_url: thumb,
    image_data_url: draft.image_data_url ? String(draft.image_data_url) : thumb,
    cta_kind: (draft.cta_kind === 'whatsapp' || draft.cta_kind === 'tel' || draft.cta_kind === 'link') ? draft.cta_kind : undefined,
    cta_label: draft.cta_label ? String(draft.cta_label).slice(0, 60) : undefined,
    cta_value: draft.cta_value ? String(draft.cta_value).slice(0, 400) : undefined,
    cta_prefill: draft.cta_prefill ? String(draft.cta_prefill).slice(0, 400) : undefined,
    duration_ms: Number.isFinite(Number(draft.duration_ms)) && Number(draft.duration_ms) > 0
      ? Math.min(30_000, Math.max(2000, Number(draft.duration_ms)))
      : 6000,
  };
  const path = pathFor(stamped.id, nowIso);
  try {
    const archivePath = await archiveImageBinary(ctx, stamped);
    if (archivePath) (stamped as Record<string, unknown>)['image_archive_path'] = archivePath;
    const result = await writeJson(ctx.env, path, stamped, `story: create ${stamped.id} by ${ctx.identity?.email ?? 'unknown'}`);
    invalidateStoryCache();
    return ok(ctx.env, ctx.req, { story: stamped, path, sha: result.sha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * POST /stories/:year/:month/:id/archive
 * Committee+ only. Flips status to `archived` without deleting the file
 * so we keep an audit trail of what was on the dashboard when.
 */
export async function archiveStory(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const { year, month, id } = params;
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `stories/${year}/${month}/${id}.json`;
  const doc = await readJson<Story>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Story not found', 404);
  if (doc.data.status === 'archived') return ok(ctx.env, ctx.req, { story: doc.data, sha: doc.sha, already: true });
  const updated: Story = {
    ...doc.data,
    status: 'archived',
    archived_at: new Date().toISOString(),
    archived_by: ctx.identity?.email ?? 'unknown',
  };
  try {
    const result = await writeJson(ctx.env, path, updated, `story: archive ${id} by ${ctx.identity?.email ?? 'unknown'}`, doc.sha);
    invalidateStoryCache();
    return ok(ctx.env, ctx.req, { story: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * DELETE /stories/:year/:month/:id
 * Admin/secretary/mgmt only — hard-delete for a story that shouldn't have
 * been posted at all. Also drops the archived binary if it exists.
 */
export async function deleteStory(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'mgmt')) return err(ctx.env, ctx.req, 'Management or above required', 403);
  const { year, month, id } = params;
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const jsonPath = `stories/${year}/${month}/${id}.json`;
  const doc = await readJson<Story>(ctx.env, jsonPath);
  if (!doc) return err(ctx.env, ctx.req, 'Story not found', 404);
  const binPath = String((doc.data as Record<string, unknown>)['image_archive_path'] || '');
  const msg = `story: delete ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    if (binPath) { try { await deleteFile(ctx.env, binPath, msg); } catch (_e) { /* best effort */ } }
    await deleteFile(ctx.env, jsonPath, msg, doc.sha);
    invalidateStoryCache();
    return ok(ctx.env, ctx.req, { deleted: true });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}
