import type { Env } from '../env.ts';
import type { AccessDoc } from '../auth/roles.ts';
import { readJson } from '../github/client.ts';

/**
 * Load the access map from the archive repo. Cached in Worker memory
 * with a soft TTL — Cloudflare recycles the isolate frequently so this
 * "cache" is naturally invalidated within minutes. Callers should not
 * rely on longer freshness than the TTL.
 */
const TTL_MS = 30_000;
let cache: { at: number; access: AccessDoc } | null = null;

export async function loadAccess(env: Env): Promise<AccessDoc> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.access;
  const doc = await readJson<AccessDoc>(env, 'config/access.json');
  const access = doc?.data ?? { role_emails: {} };
  cache = { at: Date.now(), access };
  return access;
}

/** Used by the settings write path to bust the cache immediately. */
export function invalidateAccessCache(): void {
  cache = null;
}
