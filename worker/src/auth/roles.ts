/**
 * Role resolution.
 * Given the verified caller email, look up their role from the
 * access map committed at `config/access.json` in the archive repo.
 *
 * Precedence (highest first):
 *   admin > secretary > mgmt > committee > manager > resident
 *
 * If email is not in any list → falls back to `resident`.
 * If email is null (anonymous) → returns `anonymous`.
 */

export type Role =
  | 'anonymous'
  | 'resident'
  | 'manager'
  | 'committee'
  | 'mgmt'
  | 'secretary'
  | 'admin';

export interface AccessDoc {
  role_emails?: Partial<Record<Exclude<Role, 'anonymous'>, string[]>>;
}

const ORDER: Array<Exclude<Role, 'anonymous'>> = ['admin', 'secretary', 'mgmt', 'committee', 'manager', 'resident'];

export function resolveRole(access: AccessDoc | null | undefined, email: string | null): Role {
  if (!email) return 'anonymous';
  const map = (access && access.role_emails) || {};
  for (const role of ORDER) {
    const list = map[role];
    if (Array.isArray(list) && list.map((e) => String(e).toLowerCase()).includes(email)) {
      return role;
    }
  }
  return 'resident';
}

const RANK: Record<Role, number> = {
  anonymous: 0,
  resident: 1,
  manager: 2,
  committee: 3,
  mgmt: 4,
  secretary: 5,
  admin: 6,
};

export function atLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}
