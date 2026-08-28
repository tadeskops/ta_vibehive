import type { Env } from '../env.ts';

/**
 * CORS-aware response envelope. Every route returns via `ok(env, req, body)`
 * or `err(env, req, msg, status)` so headers stay consistent.
 */

function resolveOrigin(env: Env, req: Request): string | null {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  const allow = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(origin) ? origin : null;
}

function corsHeaders(env: Env, req: Request): Record<string, string> {
  const origin = resolveOrigin(env, req);
  const h: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Vary'] = 'Origin';
    h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}

export function preflight(env: Env, req: Request): Response {
  const origin = resolveOrigin(env, req);
  if (!origin) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,If-Match,If-None-Match',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  });
}

export function ok(env: Env, req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data: body }), {
    status,
    headers: corsHeaders(env, req),
  });
}

export function err(env: Env, req: Request, message: string, status = 400, details?: unknown): Response {
  return new Response(JSON.stringify({ ok: false, error: { message, ...(details === undefined ? {} : { details }) } }), {
    status,
    headers: corsHeaders(env, req),
  });
}
