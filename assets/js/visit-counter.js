/* Daily visit counter — footer chip (desktop) + home card (mobile).
 *
 * Ported from the ta-society-helpdesk pattern. The Worker persists
 * counts in `data/visitors.json` (see worker/src/routes/metrics.ts).
 *
 * Flow:
 *   - System flag `metrics.visitor_counter` gates every surface. When
 *     OFF neither the footer chip nor the mobile card shows and no
 *     network call fires.
 *   - Once per browser per UTC day we POST /metrics/visit; on other
 *     loads we GET the current total. localStorage keeps the "already
 *     posted today" bit so a refresh doesn't inflate the counter.
 *   - We cache the last fetched figures in memory + sessionStorage so
 *     hydrating both the footer chip and the mobile card triggers at
 *     most one network round trip per page load.
 *   - Every failure is swallowed. The chip is decorative — it MUST
 *     NEVER block the app.
 */
'use strict';
import { isSystemOn } from './features.js';
import { readVisitCount, bumpVisitCount } from './api.js';

const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_KEY  = 'tvh:v1:visit_bumped_' + TODAY;
const CACHE_KEY  = 'tvh:v1:visits_cache';

function fmtN(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-IN');
}

function alreadyBumpedToday() {
  try { return !!localStorage.getItem(TODAY_KEY); } catch (_e) { return false; }
}
function markBumpedToday() {
  try { localStorage.setItem(TODAY_KEY, '1'); } catch (_e) { /* private mode */ }
}

let _memCache = null;
let _inflight = null;

function readMemCache() {
  if (_memCache) return _memCache;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw) _memCache = JSON.parse(raw);
  } catch (_e) { /* ignore */ }
  return _memCache;
}
function writeMemCache(data) {
  _memCache = data;
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_e) { /* ignore */ }
}

/**
 * Public: fetch the current visit-count figures (with dedup + cache).
 * Returns `null` if the feature is disabled or on total network fail.
 * Every visible surface (footer chip, home card) calls through this so
 * we hit the Worker at most once per page load.
 */
export async function getVisitCounts() {
  let enabled = false;
  try { enabled = await isSystemOn('metrics.visitor_counter'); } catch (_e) { enabled = false; }
  if (!enabled) return null;

  const cached = readMemCache();
  if (cached && cached.at && (Date.now() - cached.at) < 30_000) return cached.data;

  if (_inflight) return _inflight;
  _inflight = (async () => {
    let data = null;
    try {
      if (alreadyBumpedToday()) {
        data = await readVisitCount();
      } else {
        try {
          data = await bumpVisitCount();
          markBumpedToday();
        } catch (_e) {
          try { data = await readVisitCount(); } catch (_e2) { data = null; }
        }
      }
    } catch (_e) { data = null; }
    if (data) writeMemCache({ at: Date.now(), data });
    _inflight = null;
    return data;
  })();
  return _inflight;
}

/**
 * Footer chip — desktop-first, hidden on the mobile layout via CSS.
 * Idempotent: safe to call multiple times per page.
 */
export async function mountVisitCounter() {
  const wrap  = document.getElementById('footpad-visits');
  const dot   = document.getElementById('footpad-visits-dot');
  const numEl = wrap && wrap.querySelector('[data-tvh-visits-total]');
  if (!wrap || !numEl) return;

  const data = await getVisitCounts();
  if (!data || typeof data.total !== 'number') {
    wrap.hidden = true;
    wrap.style.display = 'none';
    if (dot) { dot.hidden = true; dot.style.display = 'none'; }
    return;
  }
  numEl.textContent = fmtN(data.total);
  wrap.hidden = false;
  wrap.style.display = '';
  if (dot) { dot.hidden = false; dot.style.display = ''; }
}

/**
 * Home-page card — mobile-first (also visible on desktop). Renders
 * into a caller-provided container (`<section>` or `<div>`), sized
 * like the other stat cards. Returns the element, or null if the
 * feature is disabled / offline.
 */
export async function renderVisitCard(el, styles) {
  const data = await getVisitCounts();
  if (!data || typeof data.total !== 'number') return null;
  const totalStr = fmtN(data.total);
  const todayStr = fmtN(data.today || 0);
  el.textContent = '';
  const card = document.createElement('div');
  card.className = 'card stat tvh-visit-card';
  card.setAttribute('title', 'Daily visits — updated live');
  card.style.cssText = styles || 'margin-top:12px';
  const k = document.createElement('div'); k.className = 'k'; k.textContent = 'Daily visits';
  const v = document.createElement('div'); v.className = 'v'; v.textContent = totalStr;
  const d = document.createElement('div'); d.className = 'd'; d.textContent = `${todayStr} today`;
  card.appendChild(k); card.appendChild(v); card.appendChild(d);
  el.appendChild(card);
  return card;
}
