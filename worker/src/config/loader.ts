import type { Env } from '../env.ts';
import type { AccessDoc, Role } from '../auth/roles.ts';
import { readJson } from '../github/client.ts';

/**
 * Load the access map used to resolve caller roles.
 *
 * The map is a UNION of two sources committed in the archive repo:
 *   1. `config/access.json`
 *      Long-lived admin-owned lock (edited via git / CI). Precedence
 *      source — an email listed here as `admin` can never be demoted
 *      by settings-UI edits.
 *   2. `settings/society-overrides.json` → `access.role_emails`
 *      Written from the app Settings → Roles tab by
 *      admin/secretary/mgmt roles. Used to add committee / manager /
 *      resident mappings without a code change.
 *
 * Cached in Worker memory with a soft TTL. Cloudflare recycles the
 * isolate frequently so this "cache" is naturally invalidated within
 * minutes; the settings-write path also calls `invalidateAccessCache`
 * explicitly so an admin sees their new role mapping on the next call
 * without waiting for TTL.
 */
const TTL_MS = 30_000;
let cache: { at: number; access: AccessDoc } | null = null;

type RoleEmailsMap = Partial<Record<Exclude<Role, 'anonymous'>, string[]>>;

interface OverridesDoc {
  access?: { role_emails?: RoleEmailsMap };
}

function mergeMaps(a: RoleEmailsMap, b: RoleEmailsMap): RoleEmailsMap {
  const out: RoleEmailsMap = {};
  const roles = new Set<Exclude<Role, 'anonymous'>>();
  for (const k of Object.keys(a) as Array<Exclude<Role, 'anonymous'>>) roles.add(k);
  for (const k of Object.keys(b) as Array<Exclude<Role, 'anonymous'>>) roles.add(k);
  for (const role of roles) {
    const seen = new Set<string>();
    const combined: string[] = [];
    const push = (email: unknown) => {
      const e = String(email || '').trim().toLowerCase();
      if (!e || seen.has(e)) return;
      seen.add(e);
      combined.push(e);
    };
    (a[role] || []).forEach(push);
    (b[role] || []).forEach(push);
    if (combined.length) out[role] = combined;
  }
  return out;
}

export async function loadAccess(env: Env): Promise<AccessDoc> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.access;
  const [aclDoc, overridesDoc] = await Promise.all([
    readJson<AccessDoc>(env, 'config/access.json').catch(() => null),
    readJson<OverridesDoc>(env, 'settings/society-overrides.json').catch(() => null),
  ]);
  const aclMap = (aclDoc?.data?.role_emails) || {};
  const overridesMap = (overridesDoc?.data?.access?.role_emails) || {};
  const access: AccessDoc = { role_emails: mergeMaps(aclMap, overridesMap) };
  cache = { at: Date.now(), access };
  return access;
}

/** Used by the settings write path to bust the cache immediately. */
export function invalidateAccessCache(): void {
  cache = null;
}
