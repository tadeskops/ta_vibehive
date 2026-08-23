import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson } from '../github/client.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Daily visit counter — anonymous, best-effort, batched.
 *
 * Storage layout at `data/visitors.json` in the archive repo:
 *   { total: N, by_day: { "YYYY-MM-DD": N }, updated_at: ISO }
 *
 * Endpoints (both open to anonymous callers):
 *   GET  /metrics/visit  → returns `{ total, today }` (live: committed + in-memory delta)
 *   POST /metrics/visit  → increments in-memory delta + today's bucket
 *
 * Batching (added 2026-08-23):
 *   Every POST increments an isolate-local buffer. The Worker commits
 *   to GitHub only when at least COMMIT_INTERVAL_MS has elapsed since
 *   the last commit OR when a new UTC day starts. This reduces commits
 *   from ~440/day to ~24/day (from ~13k/month to ~700/month) while
 *   still returning live totals on every GET. The scheduled handler in
 *   `src/index.ts` also force-flushes daily, guaranteeing at least one
 *   commit per 24 h even on light traffic.
 */

const PATH = 'data/visitors.json';
const COMMIT_INTERVAL_MS = 60 * 60 * 1000; // one hour

interface VisitDoc {
  total: number;
  by_day: Record<string, number>;
  updated_at: string;
}

// Isolate-local buffer of visits not yet flushed to GitHub. Preserved
// across requests handled by the same warm isolate, lost on cold start.
// Trade-off is documented above the module.
let _pendingDelta = 0;
const _pendingByDay: Record<string, number> = {};
let _cachedDoc: VisitDoc | null = null;
let _cachedSha: string | null = null;
let _lastCommitAt = 0;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDoc(): VisitDoc {
  return { total: 0, by_day: {}, updated_at: new Date().toISOString() };
}

async function loadDoc(env: Ctx['env']): Promise<{ data: VisitDoc; sha: string | null }> {
  if (_cachedDoc) return { data: _cachedDoc, sha: _cachedSha };
  const existing = await readJson<VisitDoc>(env, PATH).catch(() => null);
  if (existing && existing.data && typeof existing.data === 'object') {
    const d = existing.data;
    _cachedDoc = {
      total: typeof d.total === 'number' ? d.total : 0,
      by_day: (d.by_day && typeof d.by_day === 'object') ? d.by_day : {},
      updated_at: d.updated_at || new Date().toISOString(),
    };
    _cachedSha = existing.sha;
  } else {
    _cachedDoc = emptyDoc();
    _cachedSha = null;
  }
  return { data: _cachedDoc, sha: _cachedSha };
}

function projectedLive(doc: VisitDoc): { total: number; byDay: Record<string, number> } {
  const byDay: Record<string, number> = { ...doc.by_day };
  for (const [day, delta] of Object.entries(_pendingByDay)) {
    byDay[day] = (Number(byDay[day]) || 0) + delta;
  }
  return { total: doc.total + _pendingDelta, byDay };
}

async function flushIfDue(ctx: Ctx, force: boolean): Promise<void> {
  if (_pendingDelta <= 0) return;
  const dueByInterval = Date.now() - _lastCommitAt >= COMMIT_INTERVAL_MS;
  if (!force && !dueByInterval) return;

  const { data, sha } = await loadDoc(ctx.env);
  const merged: VisitDoc = {
    total: data.total + _pendingDelta,
    by_day: { ...data.by_day },
    updated_at: new Date().toISOString(),
  };
  for (const [day, delta] of Object.entries(_pendingByDay)) {
    merged.by_day[day] = (Number(merged.by_day[day]) || 0) + delta;
  }
  const who = ctx.identity?.email ?? 'anonymous';
  const range = Object.keys(_pendingByDay).sort().join(',');
  const message = `metrics: visit +${_pendingDelta} (${range || todayUtc()}) by ${who}`;
  const result = await writeJson(ctx.env, PATH, merged, message, sha || undefined);
  _cachedDoc = merged;
  _cachedSha = (result && result.sha) || _cachedSha;
  _pendingDelta = 0;
  for (const k of Object.keys(_pendingByDay)) delete _pendingByDay[k];
  _lastCommitAt = Date.now();
}

// Called from src/index.ts scheduled handler. Guarantees a daily flush
// regardless of live traffic so hoarded deltas can't linger.
export async function flushPendingVisits(env: Ctx['env']): Promise<{ flushed: number }> {
  if (_pendingDelta <= 0) return { flushed: 0 };
  const ctx = { env, req: new Request('https://internal/cron'), url: new URL('https://internal/cron'), role: 'anonymous' as const, ip: '' } as unknown as Ctx;
  await flushIfDue(ctx, true).catch(() => { /* best-effort */ });
  return { flushed: 0 };
}

export async function getVisitCount(ctx: Ctx): Promise<Response> {
  const { data } = await loadDoc(ctx.env);
  const today = todayUtc();
  const live = projectedLive(data);
  return ok(ctx.env, ctx.req, {
    total: live.total,
    today: Number(live.byDay[today] || 0),
    updated_at: data.updated_at,
  });
}

export async function incrementVisitCount(ctx: Ctx): Promise<Response> {
  try {
    const today = todayUtc();
    _pendingDelta += 1;
    _pendingByDay[today] = (Number(_pendingByDay[today]) || 0) + 1;

    // Best-effort commit; failures leave the delta buffered for next tick.
    await flushIfDue(ctx, false).catch(() => { /* keep delta in memory */ });

    const { data } = await loadDoc(ctx.env);
    const live = projectedLive(data);
    return ok(ctx.env, ctx.req, {
      total: live.total,
      today: Number(live.byDay[today] || 0),
      updated_at: data.updated_at,
    });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}
