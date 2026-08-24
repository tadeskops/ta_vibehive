/* Feature registry service.
 * Merges shipped defaults (features.json) with system-scope admin overrides
 * (localStorage). Event-scope flags live on the event object itself.
 *
 * System-scope overrides also persist to the shared society-overrides
 * doc under `feature_overrides` (see saveOverridesToServer + sync.js),
 * so an admin's on/off toggles reach every other device.
 */
'use strict';
import { cfg, state } from './store.js';
import * as api from './api.js';

let _catalog = null;
export async function catalog() {
  if (_catalog) return _catalog;
  _catalog = await cfg.features();
  return _catalog;
}

export async function clusters() {
  return (await catalog()).clusters;
}

export async function feature(id) {
  return (await catalog()).features.find(f => f.id === id);
}

/** Resolve the effective enabled state at system scope. */
export async function isSystemOn(id) {
  const overrides = state.featureOverrides();
  if (id in overrides) return !!overrides[id];
  const f = await feature(id);
  return !!(f && f.default);
}

/** Resolve at event scope — event.features overrides system. */
export async function isEventOn(id, event) {
  if (event && event.features && id in event.features) return !!event.features[id];
  return await isSystemOn(id);
}

export async function setSystemOverride(id, value, actor) {
  const overrides = { ...state.featureOverrides(), [id]: !!value };
  state.saveFeatureOverrides(overrides);
  state.audit({ actor: actor ? actor.id : null, action: 'features.override', feature: id, value: !!value });
}

/** Persist the current local feature overrides to the shared
 *  society-overrides doc via the Worker so every other client picks
 *  them up on next sync. Admin-only at the server. Returns the merged
 *  overrides doc on success; throws on network / auth failure so the
 *  caller can surface the error. */
export async function saveOverridesToServer(actor) {
  const feature_overrides = { ...state.featureOverrides() };
  const merged = { ...(state.societyOverrides() || {}), feature_overrides };
  await api.writeSettings(merged);
  state.saveSocietyOverrides(merged);
  state.audit({
    actor: actor ? actor.id : null,
    action: 'features.overrides.save',
    detail: Object.keys(feature_overrides).join(',') || 'cleared',
  });
  return merged;
}

/** Validate dependencies before allowing a config to be saved.
 *  A dep is satisfied when either:
 *    - it appears (true) in the per-event featuresMap being saved, OR
 *    - it is a SYSTEM-scope flag currently on (system flags are edited
 *      in Admin → Feature registry, not on the event editor).
 *  Without this, event-scope flags whose deps live at system scope
 *  (e.g. `receipt.generate` → `payment.verify`) can never save because
 *  the map only holds event-scope keys. */
export async function validateEventFeatures(featuresMap) {
  const cat = await catalog();
  const errors = [];
  for (const [id, on] of Object.entries(featuresMap)) {
    if (!on) continue;
    const f = cat.features.find(x => x.id === id);
    if (!f) continue;
    for (const dep of (f.depends_on || [])) {
      if (featuresMap[dep]) continue;                    // satisfied at event scope
      const depFeat = cat.features.find(x => x.id === dep);
      if (depFeat && depFeat.scope === 'system' && await isSystemOn(dep)) continue; // satisfied at system scope
      errors.push({ id, missing: dep });
    }
  }
  return errors;
}
