/* Long-press tooltip helper — surfaces `title` attributes on touch devices
 * where hover doesn't exist. Attaches a single global listener; any node
 * with a `title` attribute becomes tap-and-hold discoverable on mobile.
 * Desktop behaviour is unchanged (native tooltips still work).
 */
'use strict';

const LONG_PRESS_MS = 450;
let _tipEl = null;
let _timer = null;

function ensureTipEl() {
  if (_tipEl) return _tipEl;
  const t = document.createElement('div');
  t.className = 'tvh-longpress-tip';
  t.setAttribute('role', 'tooltip');
  t.setAttribute('aria-hidden', 'true');
  document.body.appendChild(t);
  _tipEl = t;
  return t;
}

function positionTip(t, x, y) {
  const pad = 8;
  const vw = window.innerWidth;
  const rect = t.getBoundingClientRect();
  let left = x - rect.width / 2;
  let top = y - rect.height - 14;
  if (left < pad) left = pad;
  if (left + rect.width > vw - pad) left = vw - pad - rect.width;
  if (top < pad) top = y + 22;
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}

function showTip(target, x, y) {
  const text = String(target.getAttribute('title') || target.getAttribute('aria-label') || '').trim();
  if (!text) return;
  target.dataset._tvhStashedTitle = text;
  target.removeAttribute('title'); // suppress the native OS bubble
  const t = ensureTipEl();
  t.textContent = text;
  t.classList.add('is-open');
  t.setAttribute('aria-hidden', 'false');
  positionTip(t, x, y);
}

function hideTip(target) {
  if (target && target.dataset && target.dataset._tvhStashedTitle) {
    target.setAttribute('title', target.dataset._tvhStashedTitle);
    delete target.dataset._tvhStashedTitle;
  }
  if (_tipEl) {
    _tipEl.classList.remove('is-open');
    _tipEl.setAttribute('aria-hidden', 'true');
  }
}

let _pressTarget = null;
let _pressX = 0, _pressY = 0;

function onTouchStart(ev) {
  const touch = ev.touches && ev.touches[0];
  if (!touch) return;
  const el = ev.target.closest('[title], [aria-label]');
  if (!el) return;
  _pressTarget = el;
  _pressX = touch.clientX;
  _pressY = touch.clientY;
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    if (_pressTarget) showTip(_pressTarget, _pressX, _pressY);
  }, LONG_PRESS_MS);
}
function onTouchMove(ev) {
  const touch = ev.touches && ev.touches[0];
  if (!touch) return;
  if (Math.abs(touch.clientX - _pressX) > 8 || Math.abs(touch.clientY - _pressY) > 8) {
    clearTimeout(_timer);
    _timer = null;
    hideTip(_pressTarget);
    _pressTarget = null;
  }
}
function onTouchEnd() {
  clearTimeout(_timer);
  _timer = null;
  setTimeout(() => { hideTip(_pressTarget); _pressTarget = null; }, 900);
}

/* Alt-key tooltip broadcast — press & hold Alt to reveal every
 * `title`/`aria-label` on the current viewport as a floating pill.
 * Release Alt to clear. Keyboard-first discoverability for power users
 * without touching mobile long-press or native OS bubbles. */
let _altOverlays = [];
const ALT_HINT_CLASS = 'tvh-alt-hint';

function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  if (r.bottom < 0 || r.top > (window.innerHeight || 0)) return false;
  if (r.right < 0 || r.left > (window.innerWidth || 0)) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false;
  return true;
}

function showAltHints() {
  hideAltHints();
  const nodes = document.querySelectorAll('[title], [aria-label]');
  const seen = new Map();
  for (const node of nodes) {
    if (!isVisible(node)) continue;
    const text = String(node.getAttribute('title') || node.getAttribute('aria-label') || '').trim();
    if (!text) continue;
    const r = node.getBoundingClientRect();
    const key = Math.round(r.left) + ':' + Math.round(r.top) + ':' + text;
    if (seen.has(key)) continue;
    seen.set(key, true);
    const pill = document.createElement('div');
    pill.className = ALT_HINT_CLASS;
    pill.textContent = text;
    document.body.appendChild(pill);
    const pw = pill.offsetWidth;
    let left = r.left + r.width / 2 - pw / 2;
    let top = r.bottom + 6;
    if (top + 28 > window.innerHeight) top = r.top - 28;
    if (left < 4) left = 4;
    if (left + pw > window.innerWidth - 4) left = window.innerWidth - 4 - pw;
    pill.style.left = left + 'px';
    pill.style.top = top + 'px';
    _altOverlays.push(pill);
  }
}

function hideAltHints() {
  for (const el of _altOverlays) el.remove();
  _altOverlays = [];
}

function onKeyDown(ev) {
  if (ev.key !== 'Alt' || ev.repeat) return;
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  showAltHints();
}
function onKeyUp(ev) {
  if (ev.key === 'Alt') hideAltHints();
}
function onBlur() { hideAltHints(); }

export function installLongPressTooltips() {
  if (installLongPressTooltips._wired) return;
  installLongPressTooltips._wired = true;
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove',  onTouchMove,  { passive: true });
  document.addEventListener('touchend',   onTouchEnd,   { passive: true });
  document.addEventListener('touchcancel',onTouchEnd,   { passive: true });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
}
