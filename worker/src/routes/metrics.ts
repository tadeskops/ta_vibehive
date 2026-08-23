import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson } from '../github/client.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Daily visit counter — unique signed-in visitors per day, plus an
 * accumulating all-time total.
 *
 * Storage layout at `data/visitors.json` in the archive repo:
 *   {
 *     total: N,                            // grand total = sum of by_day
 *     by_day: { "YYYY-MM-DD": N },        // unique visitors that day
 *     today_date: "YYYY-MM-DD",           // date the visitor set below covers
 *     today_visitors: ["user@id", ...],   // hashed / identity keys already counted today
 *     updated_at: ISO
 *   }
 *
 * Semantics:
 *   - `by_day[today]` counts UNIQUE signed-in visitors for the current UTC day
 *     (each identity contributes at most once even across browsers / devices).
 *   - `total` is the accumulated sum of daily uniques; the same person visiting
 *     on 3 different days therefore contributes 3 to the total, not 1.
 *   - Anonymous POSTs are silently ignored (return current counts without
 *     bumping) so the aggregate always reflects real, distinguishable users.
 *
 * Endpoints:
 *   GET  /metrics/visit  → `{ total, today }` (live: committed + in-memory delta)
 *   POST /metrics/visit  → dedup against caller identity, then increment if new
 *
 * Batching:
 *   POST buffers changes in the isolate. The Worker commits to GitHub only
 *   when at least COMMIT_INTERVAL_MS has elapsed since the last commit OR when
 *   a new UTC day starts. The scheduled handler in `src/index.ts` also
 *   force-flushes daily so hoarded deltas can't linger through low-traffic
 *   periods.
 */

const PATH = 'data/visitors.json';
const COMMIT_INTERVAL_MS = 60 * 60 * 1000; // one hour
const MAX_TODAY_VISITORS = 5000;           // safety cap on the per-day set

interface VisitDoc {
  total: number;
  by_day: Record<string, number>;
  today_date?: string;
  today_visitors?: string[];
  updated_at: string;
}

// Isolate-local buffer of visits not yet flushed to GitHub. Preserved
// across requests handled by the same warm isolate, lost on cold start.
// The `_todaySet` mirrors `today_visitors` for O(1) dedup during the
// day; cold-start hydrates it from the persisted document.
let _pendingDelta = 0;
const _pendingByDay: Record<string, number> = {};
let _cachedDoc: VisitDoc | null = null;
let _cachedSha: string | null = null;
let _lastCommitAt = 0;
let _todaySet: Set<string> = new Set();
let _todaySetDate = '';
let _pendingNewVisitors: string[] = [];

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDoc(): VisitDoc {
  return { total: 0, by_day: {}, updated_at: new Date().toISOString() };
}

function resetTodaySetIfStale(today: string): void {
  if (_todaySetDate !== today) {
    _todaySet = new Set();
    _todaySetDate = today;
    _pendingNewVisitors = [];
  }
}

async function loadDoc(env: Ctx['env']): Promise<{ data: VisitDoc; sha: string | null }> {
  if (_cachedDoc) return { data: _cachedDoc, sha: _cachedSha };
  const existing = await readJson<VisitDoc>(env, PATH).catch(() => null);
  const today = todayUtc();
  if (existing && existing.data && typeof existing.data === 'object') {
    const d = existing.data;
    _cachedDoc = {
      total: typeof d.total === 'number' ? d.total : 0,
      by_day: (d.by_day && typeof d.by_day === 'object') ? d.by_day : {},
      today_date: typeof d.today_date === 'string' ? d.today_date : undefined,
      today_visitors: Array.isArray(d.today_visitors) ? d.today_visitors.slice(0, MAX_TODAY_VISITORS) : [],
      updated_at: d.updated_at || new Date().toISOString(),
    };
    _cachedSha = existing.sha;
  } else {
    _cachedDoc = emptyDoc();
    _cachedSha = null;
  }
  // Hydrate the in-memory dedup set from persisted data, but only if it
  // belongs to the current UTC day — stale sets are discarded.
  resetTodaySetIfStale(today);
  if (_cachedDoc.today_date === today && Array.isArray(_cachedDoc.today_visitors)) {
    for (const id of _cachedDoc.today_visitors) _todaySet.add(id);
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
  const today = todayUtc();
  const mergedTodayVisitors = (data.today_date === today && Array.isArray(data.today_visitors))
    ? Array.from(new Set([...data.today_visitors, ..._pendingNewVisitors])).slice(0, MAX_TODAY_VISITORS)
    : _pendingNewVisitors.slice(0, MAX_TODAY_VISITORS);
  const merged: VisitDoc = {
    total: data.total + _pendingDelta,
    by_day: { ...data.by_day },
    today_date: today,
    today_visitors: mergedTodayVisitors,
    updated_at: new Date().toISOString(),
  };
  for (const [day, delta] of Object.entries(_pendingByDay)) {
    merged.by_day[day] = (Number(merged.by_day[day]) || 0) + delta;
  }
  const who = ctx.identity?.email ?? 'anonymous';
  const range = Object.keys(_pendingByDay).sort().join(',');
  const message = `metrics: visit +${_pendingDelta} (${range || today}) by ${who}`;
  const result = await writeJson(ctx.env, PATH, merged, message, sha || undefined);
  _cachedDoc = merged;
  _cachedSha = (result && result.sha) || _cachedSha;
  _pendingDelta = 0;
  for (const k of Object.keys(_pendingByDay)) delete _pendingByDay[k];
  _pendingNewVisitors = [];
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
    // Hydrate the in-memory dedup set from persisted storage on cold
    // start, then apply per-day uniqueness on the caller identity.
    await loadDoc(ctx.env);
    resetTodaySetIfStale(today);

    const identity = ctx.identity?.email || ctx.identity?.id || '';
    if (!identity) {
      // Anonymous POST — do not count. Return current live figures.
      const { data } = await loadDoc(ctx.env);
      const live = projectedLive(data);
      return ok(ctx.env, ctx.req, {
        total: live.total,
        today: Number(live.byDay[today] || 0),
        updated_at: data.updated_at,
      });
    }

    const visitorKey = String(identity).toLowerCase();
    if (!_todaySet.has(visitorKey) && _todaySet.size < MAX_TODAY_VISITORS) {
      _todaySet.add(visitorKey);
      _pendingNewVisitors.push(visitorKey);
      _pendingDelta += 1;
      _pendingByDay[today] = (Number(_pendingByDay[today]) || 0) + 1;
    }

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
