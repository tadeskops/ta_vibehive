/* Role-based access control. Reads config/roles.json permissions. */
'use strict';
import { cfg } from './store.js';

let _cache = null;
async function permMap() {
  if (_cache) return _cache;
  _cache = (await cfg.roles()).permissions;
  return _cache;
}

export async function can(user, permission) {
  if (!user) return false;
  const map = await permMap();
  const allowed = map[permission] || [];
  return allowed.includes(user.role);
}

export async function requireRole(user, ...roles) {
  return !!user && roles.includes(user.role);
}

export async function rankOf(role) {
  const r = (await cfg.roles()).hierarchy.find(h => h.id === role);
  return r ? r.rank : 0;
}

export async function outranks(a, b) {
  return (await rankOf(a)) > (await rankOf(b));
}

export async function labelForRole(role) {
  const r = (await cfg.roles()).hierarchy.find(h => h.id === role);
  return r ? r.label : role;
}

export async function badgeClass(role) {
  const r = (await cfg.roles()).hierarchy.find(h => h.id === role);
  return r ? r.badge : 'role-badge';
}
