/**
 * Item contributions endpoint — parallel to the money contributions
 * route but stores goods pledged by residents against an event's
 * "wishlist" catalog.
 *
 * Storage layout in the archive repo:
 *   item_contributions/{YYYY}/{MM}/{itemContribId}.json
 *
 * Each file is self-contained:
 *   { id, event, item_id, item_name, item_glyph, unit, quantity,
 *     is_custom, contributor_name, contributor_email, contributor_flat,
 *     contributor_mobile, note, status, created_at, created_by,
 *     accepted_at?, accepted_by?, received_at?, received_by?,
 *     void_at?, void_by?, void_reason? }
 *
 * Lifecycle: pending -> accepted -> received (each step is a
 * committee action). Void can happen from any prior state.
 */
import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson, listDir } from '../github/client.ts';
import { atLeast } from '../auth/roles.ts';
import { HttpError } from '../lib/errors.ts';

interface ItemContribution extends Record<string, unknown> {
  id: string;
  event: string;
  item_id?: string;
  item_name: string;
  item_glyph?: string;
  unit?: string;
  quantity: number;
  is_custom?: boolean;
  status: 'pending' | 'accepted' | 'received' | 'void';
  contributor_name?: string;
  contributor_email?: string;
  contributor_flat?: string;
  contributor_mobile?: string;
  note?: string;
  created_at?: string;
  created_by?: string;
  accepted_at?: string;
  accepted_by?: string;
  received_at?: string;
  received_by?: string;
  void_at?: string;
  void_by?: string;
  void_reason?: string;
}

function pathFor(id: string, created?: string): string {
  const d = created ? new Date(created) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const safe = String(id || '').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 60);
  return `item_contributions/${y}/${m}/${safe}.json`;
}

function newId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(36))
    .join('');
  return `ic-${Date.now().toString(36)}-${rand}`;
}

export async function createItemContribution(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  let body: { item_contribution?: Partial<ItemContribution> };
  try { body = await ctx.req.json(); } catch (_e) { return err(ctx.env, ctx.req, 'Invalid JSON body', 400); }
  const draft = body.item_contribution;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return err(ctx.env, ctx.req, '`item_contribution` must be an object', 400);
  }
  if (!draft.event || typeof draft.event !== 'string') return err(ctx.env, ctx.req, 'event is required', 400);
  if (!draft.item_name || typeof draft.item_name !== 'string') return err(ctx.env, ctx.req, 'item_name is required', 400);
  if (typeof draft.quantity !== 'number' || !(draft.quantity > 0)) return err(ctx.env, ctx.req, 'quantity must be positive', 400);
  const nowIso = new Date().toISOString();
  const stamped: ItemContribution = {
    ...(draft as ItemContribution),
    id: newId(),
    status: 'pending',
    created_at: nowIso,
    created_by: ctx.identity?.email ?? 'unknown',
  };
  const path = pathFor(stamped.id, nowIso);
  const message = `item-contribution: pledged ${stamped.quantity}× ${stamped.item_name} for ${stamped.event} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, stamped, message);
    return ok(ctx.env, ctx.req, { item_contribution: stamped, path, sha: result.sha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

async function transition(
  ctx: Ctx,
  params: Record<string, string>,
  guard: (doc: ItemContribution) => Response | null,
  apply: (doc: ItemContribution, actorEmail: string, reason?: string) => ItemContribution,
  action: string,
): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `item_contributions/${year}/${month}/${id}.json`;
  const doc = await readJson<ItemContribution>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Item contribution not found', 404);
  const guardResp = guard(doc.data);
  if (guardResp) return guardResp;
  let reason: string | undefined;
  try {
    const body = await ctx.req.json() as { reason?: string };
    if (body && typeof body.reason === 'string') reason = body.reason.trim() || undefined;
  } catch (_e) { /* no body is fine */ }
  const updated = apply(doc.data, ctx.identity?.email ?? 'unknown', reason);
  const message = `item-contribution: ${action} ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, updated, message, doc.sha);
    return ok(ctx.env, ctx.req, { item_contribution: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

export async function acceptItemContribution(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  return transition(
    ctx, params,
    (d) => d.status !== 'pending' ? ok(ctx.env, ctx.req, { item_contribution: d, already: true }) : null,
    (d, email) => ({ ...d, status: 'accepted', accepted_at: new Date().toISOString(), accepted_by: email }),
    'accepted',
  );
}

export async function receiveItemContribution(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  return transition(
    ctx, params,
    (d) => d.status === 'received' ? ok(ctx.env, ctx.req, { item_contribution: d, already: true })
         : (d.status !== 'accepted' && d.status !== 'pending') ? err(ctx.env, ctx.req, 'Only pending or accepted pledges can be marked received', 409)
         : null,
    (d, email) => ({ ...d, status: 'received', received_at: new Date().toISOString(), received_by: email,
      accepted_at: d.accepted_at ?? new Date().toISOString(),
      accepted_by: d.accepted_by ?? email,
    }),
    'received',
  );
}

export async function voidItemContribution(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  return transition(
    ctx, params,
    (d) => d.status === 'void' ? ok(ctx.env, ctx.req, { item_contribution: d, already: true }) : null,
    (d, email, reason) => ({ ...d, status: 'void', void_at: new Date().toISOString(), void_by: email, void_reason: reason }),
    'voided',
  );
}

export async function listItemContributions(ctx: Ctx): Promise<Response> {
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
  const out: ItemContribution[] = [];
  for (const { y, m } of months) {
    const entries = await listDir(ctx.env, `item_contributions/${y}/${m}`);
    for (const e of entries) {
      if (e.type !== 'file' || !e.name.endsWith('.json')) continue;
      const doc = await readJson<ItemContribution>(ctx.env, e.path);
      if (!doc || !doc.data) continue;
      const c = doc.data;
      if (eventFilter && c.event !== eventFilter) continue;
      if (canSeeAll) {
        out.push(c);
        continue;
      }
      const mine = String(c.contributor_email || c.created_by || '').toLowerCase() === callerEmail;
      if (mine) out.push(c);
    }
  }
  return ok(ctx.env, ctx.req, { item_contributions: out });
}
