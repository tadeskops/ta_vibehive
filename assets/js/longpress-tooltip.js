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

export function installLongPressTooltips() {
  if (installLongPressTooltips._wired) return;
  installLongPressTooltips._wired = true;
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove',  onTouchMove,  { passive: true });
  document.addEventListener('touchend',   onTouchEnd,   { passive: true });
  document.addEventListener('touchcancel',onTouchEnd,   { passive: true });
}
