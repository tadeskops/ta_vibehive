import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson } from '../github/client.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Daily visit counter — anonymous, best-effort.
 *
 * Storage layout at `data/visitors.json` in the archive repo:
 *   { total: N, by_day: { "YYYY-MM-DD": N }, updated_at: ISO }
 *
 * Endpoints (both are open to anonymous callers so first-time visitors
 * without a Google session still count):
 *   GET  /metrics/visit  → returns `{ total, today }`
 *   POST /metrics/visit  → increments today's bucket + total, returns new figures
 *
 * The client is expected to POST at most once per browser per UTC day
 * (localStorage guard). The Worker does no per-caller dedup — the
 * archive commit is deliberately cheap; abusive callers only bloat the
 * counter and can be reset from the archive repo.
 */

const PATH = 'data/visitors.json';

interface VisitDoc {
  total: number;
  by_day: Record<string, number>;
  updated_at: string;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDoc(): VisitDoc {
  return { total: 0, by_day: {}, updated_at: new Date().toISOString() };
}

async function readOrEmpty(env: Ctx['env']): Promise<{ data: VisitDoc; sha: string | null }> {
  const existing = await readJson<VisitDoc>(env, PATH).catch(() => null);
  if (existing && existing.data && typeof existing.data === 'object') {
    /* Fill in missing fields for backward-compatibility with older docs. */
    const d = existing.data;
    return {
      data: {
        total: typeof d.total === 'number' ? d.total : 0,
        by_day: (d.by_day && typeof d.by_day === 'object') ? d.by_day : {},
        updated_at: d.updated_at || new Date().toISOString(),
      },
      sha: existing.sha,
    };
  }
  return { data: emptyDoc(), sha: null };
}

export async function getVisitCount(ctx: Ctx): Promise<Response> {
  const { data } = await readOrEmpty(ctx.env);
  const today = todayUtc();
  return ok(ctx.env, ctx.req, {
    total: data.total,
    today: Number(data.by_day[today] || 0),
    updated_at: data.updated_at,
  });
}

export async function incrementVisitCount(ctx: Ctx): Promise<Response> {
  try {
    const { data, sha } = await readOrEmpty(ctx.env);
    const today = todayUtc();
    const next: VisitDoc = {
      total: (Number(data.total) || 0) + 1,
      by_day: { ...data.by_day, [today]: (Number(data.by_day[today]) || 0) + 1 },
      updated_at: new Date().toISOString(),
    };
    const who = ctx.identity?.email ?? 'anonymous';
    const message = `metrics: visit +1 (${today}) by ${who}`;
    await writeJson(ctx.env, PATH, next, message, sha || undefined);
    return ok(ctx.env, ctx.req, {
      total: next.total,
      today: next.by_day[today] || 0,
      updated_at: next.updated_at,
    });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}
