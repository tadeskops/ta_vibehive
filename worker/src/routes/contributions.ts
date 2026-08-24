import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson, listDir } from '../github/client.ts';
import { atLeast } from '../auth/roles.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Contribution storage layout in the archive repo:
 *   contributions/{YYYY}/{MM}/{contribId}.json
 *
 * Each file is a self-contained record:
 *   { id, event, amount, contributor: {name,email,flat,mobile},
 *     method, ref, status, remarks, created_at, created_by,
 *     verified_at?, verified_by?, receipt_id? }
 *
 * Anyone signed in can create (self or on-behalf). Committee+ can
 * verify. Committee+ can list all; residents can list their own only.
 */

interface Contribution extends Record<string, unknown> {
  id: string;
  event: string;
  amount: number;
  status: 'pending' | 'verified' | 'void';
  contributor_email?: string;
  created_at?: string;
  created_by?: string;
  verified_at?: string;
  verified_by?: string;
  receipt_id?: string;
}

function pathFor(id: string, created?: string): string {
  const d = created ? new Date(created) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const safe = String(id || '').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 60);
  return `contributions/${y}/${m}/${safe}.json`;
}

function newId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(36))
    .join('');
  return `c-${Date.now().toString(36)}-${rand}`;
}

/**
 * POST /contributions
 * Body: { contribution: Partial<Contribution> }
 * Any signed-in user (or anonymous when publicly configured — not
 * enabled by default). Server stamps id, created_at, created_by,
 * status='pending'.
 */
export async function createContribution(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  let body: { contribution?: Partial<Contribution> };
  try { body = await ctx.req.json(); } catch (_e) { return err(ctx.env, ctx.req, 'Invalid JSON body', 400); }
  const draft = body.contribution;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return err(ctx.env, ctx.req, '`contribution` must be an object', 400);
  }
  if (!draft.event || typeof draft.event !== 'string') return err(ctx.env, ctx.req, 'event is required', 400);
  if (typeof draft.amount !== 'number' || !(draft.amount > 0)) return err(ctx.env, ctx.req, 'amount must be positive', 400);
  const nowIso = new Date().toISOString();
  const stamped: Contribution = {
    ...(draft as Contribution),
    id: newId(),
    status: 'pending',
    created_at: nowIso,
    created_by: ctx.identity?.email ?? 'unknown',
  };
  const path = pathFor(stamped.id, nowIso);
  const message = `contribution: submitted by ${ctx.identity?.email ?? 'unknown'} for ${stamped.event}`;
  try {
    const result = await writeJson(ctx.env, path, stamped, message);
    return ok(ctx.env, ctx.req, { contribution: stamped, path, sha: result.sha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * POST /contributions/:year/:month/:id/verify
 * Committee+ only. Body: {}. Server marks status='verified', stamps
 * verified_at/verified_by. Optionally mints a deterministic receipt id.
 */
export async function verifyContribution(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  /* Anonymous callers get a 401 so the frontend's silent-refresh
   * retry can attempt to recover the session. Genuine role
   * mismatches still fall through to 403. */
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `contributions/${year}/${month}/${id}.json`;
  const doc = await readJson<Contribution>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Contribution not found', 404);
  if (doc.data.status === 'verified') return ok(ctx.env, ctx.req, { contribution: doc.data, sha: doc.sha, already: true });
  const verifiedAt = new Date().toISOString();
  const receiptId = mintReceiptId(doc.data, verifiedAt);
  const updated: Contribution = {
    ...doc.data,
    status: 'verified',
    verified_at: verifiedAt,
    verified_by: ctx.identity?.email ?? 'unknown',
    receipt_id: receiptId,
  };
  const message = `contribution: verified ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, updated, message, doc.sha);
    return ok(ctx.env, ctx.req, { contribution: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * POST /contributions/:year/:month/:id/void
 * Committee+ only. Body: { reason?: string }. Marks status='void'
 * without deleting the file, preserving the audit trail.
 */
export async function voidContribution(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `contributions/${year}/${month}/${id}.json`;
  const doc = await readJson<Contribution>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Contribution not found', 404);
  if (doc.data.status === 'void') return ok(ctx.env, ctx.req, { contribution: doc.data, sha: doc.sha, already: true });
  let reason: string | undefined;
  try {
    const body = await ctx.req.json() as { reason?: string };
    if (body && typeof body.reason === 'string') reason = body.reason.trim() || undefined;
  } catch (_e) { /* no body is fine */ }
  const nowIso = new Date().toISOString();
  const updated: Contribution = {
    ...doc.data,
    status: 'void',
    void_at: nowIso,
    void_by: ctx.identity?.email ?? 'unknown',
    void_reason: reason,
  };
  const message = `contribution: voided ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, updated, message, doc.sha);
    return ok(ctx.env, ctx.req, { contribution: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * GET /contributions?event=<slug>
 * Committee+ sees full data for every contribution. Residents see
 * their OWN records in full and every OTHER record with sensitive
 * fields (email, ref, remarks, receipt id) stripped so a resident
 * cannot fingerprint or replay another resident's payment.
 *
 * Names, flats and amounts stay on the wire so the frontend can render
 * a community feed and compute totals; hiding a specific field from
 * the visual list is a UI concern handled per-view in home.js.
 *
 * Anonymous callers get 401.
 */
function stripPrivateFields(c: Contribution): Contribution {
  const out: Contribution = {
    id: c.id,
    event: c.event,
    amount: c.amount,
    status: c.status,
    created_at: c.created_at,
    verified_at: c.verified_at,
  };
  const src = c as Record<string, unknown>;
  if (typeof src['contributor_name'] === 'string') out['contributor_name'] = src['contributor_name'];
  if (typeof src['flat'] === 'string') out['flat'] = src['flat'];
  if (typeof src['method'] === 'string') out['method'] = src['method'];
  if (typeof src['anonymous'] === 'boolean') out['anonymous'] = src['anonymous'];
  return out;
}

export async function listContributions(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  const eventFilter = ctx.url.searchParams.get('event') || '';
  const now = new Date();
  const months: Array<{ y: number; m: string }> = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ y: d.getUTCFullYear(), m: String(d.getUTCMonth() + 1).padStart(2, '0') });
  }
  const callerEmail = String(ctx.identity?.email || '').toLowerCase();
  const canSeeAll = atLeast(ctx.role, 'committee');
  const out: Contribution[] = [];
  for (const { y, m } of months) {
    const entries = await listDir(ctx.env, `contributions/${y}/${m}`);
    for (const e of entries) {
      if (e.type !== 'file' || !e.name.endsWith('.json')) continue;
      const doc = await readJson<Contribution>(ctx.env, e.path);
      if (!doc || !doc.data) continue;
      const c = doc.data;
      if (eventFilter && c.event !== eventFilter) continue;
      if (canSeeAll) {
        out.push(c);
        continue;
      }
      const mine = String(c.contributor_email || c.created_by || '').toLowerCase() === callerEmail;
      out.push(mine ? c : stripPrivateFields(c));
    }
  }
  return ok(ctx.env, ctx.req, { contributions: out });
}

/**
 * Deterministic receipt id derived from event type + verification timestamp.
 * Format: <EVENT_TYPE>-<YYYYMMDD>-<HHMM>. Matches the frontend policy
 * so verified contributions can be referenced consistently on either
 * side of the wire.
 */
function mintReceiptId(c: Contribution, verifiedAt: string): string {
  const t = new Date(verifiedAt);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  const type = String(c['cluster'] || c['template'] || c['event'] || 'EVENT')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return `${type}-${y}${m}${d}-${hh}${mm}`;
}
