/**
 * Expenses endpoint — mirrors the contributions storage layout so
 * committee members can see and verify expenses that residents submit
 * from any device. Prior to this route, expenses lived only in local
 * storage, which meant a moderator on device B never saw an expense
 * that resident A submitted on device A.
 *
 * Storage layout in the archive repo:
 *   expenses/{YYYY}/{MM}/{expenseId}.json
 *
 * Each file is a self-contained record; verify replaces the file in
 * place with `status='verified'` + verifier metadata.
 *
 * Access:
 *   - GET  /expenses[?event=<slug>]  — signed-in required.
 *       committee+ sees every expense in scope; residents only see
 *       expenses they logged themselves.
 *   - POST /expenses                 — signed-in required. Server
 *       stamps id, created_at, created_by, status='pending'.
 *   - POST /expenses/:y/:m/:id/verify — committee+ only. Marks
 *       status='verified' + verifier metadata.
 */
import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, readManyJson, writeJson, listDir, deleteFile } from '../github/client.ts';
import { atLeast } from '../auth/roles.ts';
import { HttpError } from '../lib/errors.ts';

interface Expense extends Record<string, unknown> {
  id: string;
  event_id: string;
  amount: number;
  status: 'pending' | 'approved' | 'verified' | 'void';
  category?: string;
  description?: string;
  created_at?: string;
  created_by?: string;
  verified_at?: string;
  verified_by?: string;
  verified_comment?: string;
  visible_to_residents?: boolean;
}

function pathFor(id: string, created?: string): string {
  const d = created ? new Date(created) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const safe = String(id || '').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 60);
  return `expenses/${y}/${m}/${safe}.json`;
}

function newId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(36))
    .join('');
  return `exp-${Date.now().toString(36)}-${rand}`;
}

// Idempotency lookup: the client attaches a stable `client_token` to
// each submission and api.js transparently retries POSTs on cold-start
// / 5xx. Without this, a retry after a write that already succeeded
// creates a duplicate expense. We scan the current + previous month
// (a retry lands within seconds, so it shares the created_at month in
// all but the rarest boundary case) for a record carrying the same
// token + event, and return it so the retry is a no-op.
async function findByClientToken(
  env: Ctx['env'],
  eventId: string,
  token: string,
): Promise<{ data: Expense; path: string; sha: string } | null> {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const months = [
    { y: now.getUTCFullYear(), m: String(now.getUTCMonth() + 1).padStart(2, '0') },
    { y: prev.getUTCFullYear(), m: String(prev.getUTCMonth() + 1).padStart(2, '0') },
  ];
  const paths: string[] = [];
  for (const { y, m } of months) {
    const entries = await listDir(env, `expenses/${y}/${m}`);
    for (const e of entries) {
      if (e.type === 'file' && e.name.endsWith('.json')) paths.push(e.path);
    }
  }
  if (!paths.length) return null;
  const blobs = await readManyJson<Expense>(env, paths);
  for (const p of paths) {
    const doc = blobs.get(p);
    if (!doc || !doc.data) continue;
    const d = doc.data as Record<string, unknown>;
    if (String(d['client_token'] || '') === token && String(d['event_id'] || '') === eventId) {
      return { data: doc.data, path: p, sha: doc.sha };
    }
  }
  return null;
}

export async function createExpense(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  let body: { expense?: Partial<Expense> };
  try { body = await ctx.req.json(); } catch (_e) { return err(ctx.env, ctx.req, 'Invalid JSON body', 400); }
  const draft = body.expense;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return err(ctx.env, ctx.req, '`expense` must be an object', 400);
  }
  if (!draft.event_id || typeof draft.event_id !== 'string') return err(ctx.env, ctx.req, 'event_id is required', 400);
  if (typeof draft.amount !== 'number' || !(draft.amount > 0)) return err(ctx.env, ctx.req, 'amount must be positive', 400);
  // Idempotency: a retried POST carries the same client_token. Return
  // the already-written record as success instead of duplicating it.
  const clientToken = typeof draft['client_token'] === 'string' ? String(draft['client_token']).trim().slice(0, 80) : '';
  if (clientToken) {
    const existing = await findByClientToken(ctx.env, draft.event_id, clientToken);
    if (existing) {
      return ok(ctx.env, ctx.req, { expense: existing.data, path: existing.path, sha: existing.sha, idempotent: true });
    }
  }
  const nowIso = new Date().toISOString();
  // Committee+ may create rows already in verified status (recording
  // an already-paid expense). Everyone else is forced to pending.
  const requested = typeof draft.status === 'string' ? draft.status : 'pending';
  const initial: Expense['status'] = atLeast(ctx.role, 'committee') && requested === 'verified' ? 'verified' : 'pending';
  const stamped: Expense = {
    ...(draft as Expense),
    id: newId(),
    status: initial,
    created_at: nowIso,
    created_by: ctx.identity?.email ?? 'unknown',
    verified_at: initial === 'verified' ? nowIso : undefined,
    verified_by:  initial === 'verified' ? (ctx.identity?.email ?? 'unknown') : undefined,
  };
  const path = pathFor(stamped.id, nowIso);
  const message = `expense: submitted by ${ctx.identity?.email ?? 'unknown'} for ${stamped.event_id}`;
  try {
    const result = await writeJson(ctx.env, path, stamped, message);
    return ok(ctx.env, ctx.req, { expense: stamped, path, sha: result.sha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

export async function verifyExpense(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `expenses/${year}/${month}/${id}.json`;
  const doc = await readJson<Expense>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Expense not found', 404);
  if (doc.data.status === 'verified') return ok(ctx.env, ctx.req, { expense: doc.data, sha: doc.sha, already: true });
  let comment: string | undefined;
  try {
    const body = await ctx.req.json() as { comment?: string };
    if (body && typeof body.comment === 'string') comment = body.comment.trim() || undefined;
  } catch (_e) { /* no body is fine */ }
  const nowIso = new Date().toISOString();
  const updated: Expense = {
    ...doc.data,
    status: 'verified',
    verified_at: nowIso,
    verified_by: ctx.identity?.email ?? 'unknown',
    verified_comment: comment,
  };
  const message = `expense: verified ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, updated, message, doc.sha);
    return ok(ctx.env, ctx.req, { expense: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

export async function putExpense(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `expenses/${year}/${month}/${id}.json`;
  const doc = await readJson<Expense>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Expense not found', 404);
  let body: { expense?: Partial<Expense> };
  try { body = await ctx.req.json(); } catch (_e) { return err(ctx.env, ctx.req, 'Invalid JSON body', 400); }
  const patch = body.expense;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return err(ctx.env, ctx.req, '`expense` must be an object', 400);
  }
  const nowIso = new Date().toISOString();
  // Committee+ drive the lifecycle here (pending → approved → verified,
  // or void). The status + its stamps (approved_*, processed_*,
  // verified_*) ARE mutable via this route — only true provenance
  // (id, event_id, created_at, created_by) is immutable. Previously
  // status/verified_* were hard-locked, which silently discarded every
  // approve/process action and made verification appear to "not save".
  const ALLOWED_STATUS = new Set(['pending', 'approved', 'verified', 'void']);
  const nextStatus: Expense['status'] =
    typeof patch.status === 'string' && ALLOWED_STATUS.has(patch.status)
      ? (patch.status as Expense['status'])
      : doc.data.status;
  const updated: Expense = {
    ...doc.data,
    ...patch,
    id: doc.data.id,
    event_id: doc.data.event_id,
    created_at: doc.data.created_at,
    created_by: doc.data.created_by,
    status: nextStatus,
    updated_at: nowIso,
    updated_by: ctx.identity?.email ?? 'unknown',
  } as Expense;
  const message = `expense: updated ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, updated, message, doc.sha);
    return ok(ctx.env, ctx.req, { expense: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

export async function deleteExpense(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `expenses/${year}/${month}/${id}.json`;
  const message = `expense: deleted ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await deleteFile(ctx.env, path, message);
    return ok(ctx.env, ctx.req, { deleted: !!result, path });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

export async function listExpenses(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  const eventFilter = ctx.url.searchParams.get('event') || '';
  const now = new Date();
  const months: Array<{ y: number; m: string }> = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ y: d.getUTCFullYear(), m: String(d.getUTCMonth() + 1).padStart(2, '0') });
  }
  const paths: string[] = [];
  for (const { y, m } of months) {
    const entries = await listDir(ctx.env, `expenses/${y}/${m}`);
    for (const e of entries) {
      if (e.type !== 'file' || !e.name.endsWith('.json')) continue;
      paths.push(e.path);
    }
  }
  const out: Expense[] = [];
  if (paths.length) {
    /* Batch every expense JSON into ONE GraphQL request. See
     * `readManyJson` in ../github/client.ts for why (Cloudflare
     * Workers Free plan caps a request at 50 outbound subrequests). */
    const blobs = await readManyJson<Expense>(ctx.env, paths);
    for (const p of paths) {
      const doc = blobs.get(p);
      if (!doc || !doc.data) continue;
      const x = doc.data;
      if (eventFilter && x.event_id !== eventFilter) continue;
      if (!atLeast(ctx.role, 'committee')) {
        const mine = String(x.created_by || '').toLowerCase() === (ctx.identity?.email || '');
        if (!mine) continue;
      }
      out.push(x);
    }
  }
  return ok(ctx.env, ctx.req, { expenses: out });
}
