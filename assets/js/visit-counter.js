/* Daily visit counter — footer chip.
 *
 * Ported from the ta-society-helpdesk pattern. The Worker persists
 * counts in `data/visitors.json` (see worker/src/routes/metrics.ts).
 *
 * Flow:
 *   - System flag `metrics.visitor_counter` gates the widget entirely.
 *     When OFF the chip stays hidden and no network call fires.
 *   - Once per browser per UTC day we POST /metrics/visit; on other
 *     loads we GET the current total. localStorage keeps the "already
 *     posted today" bit so a refresh doesn't inflate the counter.
 *   - Every failure is swallowed. The chip is decorative — it MUST
 *     NEVER block the app.
 */
'use strict';
import { isSystemOn } from './features.js';
import { readVisitCount, bumpVisitCount } from './api.js';

const TODAY_KEY = 'tvh:v1:visit_bumped_' + new Date().toISOString().slice(0, 10);

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

export async function mountVisitCounter() {
  const wrap  = document.getElementById('footpad-visits');
  const dot   = document.getElementById('footpad-visits-dot');
  const numEl = wrap && wrap.querySelector('[data-tvh-visits-total]');
  if (!wrap || !numEl) return;

  let enabled = false;
  try { enabled = await isSystemOn('metrics.visitor_counter'); } catch (_e) { enabled = false; }
  if (!enabled) {
    wrap.hidden = true;
    wrap.style.display = 'none';
    if (dot) { dot.hidden = true; dot.style.display = 'none'; }
    return;
  }

  let data = null;
  try {
    if (alreadyBumpedToday()) {
      data = await readVisitCount();
    } else {
      try {
        data = await bumpVisitCount();
        markBumpedToday();
      } catch (_e) {
        /* increment failed — fall back to a read so the chip still
         * shows something rather than staying blank. */
        try { data = await readVisitCount(); } catch (_e2) { /* give up */ }
      }
    }
  } catch (_e) {
    /* total network failure — keep the chip hidden. */
    return;
  }

  if (data && typeof data.total === 'number') {
    numEl.textContent = fmtN(data.total);
    wrap.hidden = false;
    wrap.style.display = '';
    if (dot) { dot.hidden = false; dot.style.display = ''; }
  }
}
