import type { Env } from '../env.ts';

/** Structured log line. LOG_LEVEL controls what makes it to console. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function line(env: Env, level: Level, event: string, extra?: Record<string, unknown>) {
  const min = ORDER[(env.LOG_LEVEL as Level) || 'info'] ?? 1;
  if (ORDER[level] < min) return;
  const payload = { ts: new Date().toISOString(), level, event, ...(extra || {}) };
  const s = JSON.stringify(payload);
  if (level === 'error') console.error(s);
  else if (level === 'warn') console.warn(s);
  else console.log(s);
}

export const log = {
  debug(env: Env, event: string, extra?: Record<string, unknown>) { line(env, 'debug', event, extra); },
  info(env: Env, event: string, extra?: Record<string, unknown>) { line(env, 'info', event, extra); },
  warn(env: Env, event: string, extra?: Record<string, unknown>) { line(env, 'warn', event, extra); },
  error(env: Env, event: string, extra?: Record<string, unknown>) { line(env, 'error', event, extra); },
};
