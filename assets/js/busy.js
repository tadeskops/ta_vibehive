/* busy.js — ref-counted background-activity tracker.
 *
 * Toggles <body class="is-busy"> while any async operation is inflight.
 * The topbar renders a golden shimmer stripe on the bottom edge whenever
 * this class is set (see base.css .topbar::after).
 *
 * Usage:
 *   import { busy } from './busy.js';
 *   const done = busy.start('Saving contribution…');
 *   try { await work(); } finally { done(); }
 *
 * Or wrap a promise directly:
 *   await busy.wrap('Verifying…', () => api.verify(id));
 *
 * The global fetch() is auto-wrapped by app.js so every network call
 * contributes to the counter without any per-caller change.
 */
'use strict';

let count = 0;
const labels = [];
const listeners = new Set();

function apply() {
  const on = count > 0;
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('is-busy', on);
    const label = labels[labels.length - 1] || '';
    if (label) document.body.setAttribute('data-busy-label', label);
    else document.body.removeAttribute('data-busy-label');
  }
  for (const cb of listeners) { try { cb(on, count, labels[labels.length - 1]); } catch { /* isolated */ } }
}

export const busy = {
  start(label) {
    count += 1;
    if (label) labels.push(String(label));
    apply();
    let done = false;
    return function end() {
      if (done) return;
      done = true;
      count = Math.max(0, count - 1);
      if (label) {
        const i = labels.lastIndexOf(String(label));
        if (i >= 0) labels.splice(i, 1);
      }
      apply();
    };
  },
  async wrap(label, fn) {
    const end = busy.start(label);
    try { return await fn(); } finally { end(); }
  },
  on(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  active() { return count; },
};

/** Install a global fetch wrapper that auto-participates in the busy count.
 *  Idempotent — calling twice is a no-op. Skips data:/blob: URLs. */
export function installFetchWrapper() {
  if (typeof window === 'undefined' || !window.fetch) return;
  if (window.fetch.__tvhBusy) return;
  const orig = window.fetch.bind(window);
  const wrapped = async function tvhBusyFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.startsWith('data:') || url.startsWith('blob:')) return orig(input, init);
    const end = busy.start('Network…');
    try { return await orig(input, init); }
    finally { end(); }
  };
  wrapped.__tvhBusy = true;
  window.fetch = wrapped;
}

/** Wrap an async save action with a rotating ring inside a button.
 *
 *  While `fn()` is inflight, the button is disabled, its label is
 *  replaced with a `.tvh-saving-ring` + optional `savingLabel`, and
 *  the global busy counter is incremented so the header shine also
 *  runs. On resolve/reject the original label + enabled state are
 *  restored. Re-entrant calls are ignored (`data-tvh-saving="1"`).
 *
 *  Returns whatever `fn()` returned (or re-throws its error) so
 *  callers can chain toasts / refreshes off the same promise. */
export async function withSavingRing(btn, fn, { savingLabel = 'Saving…', busyLabel = 'Saving…' } = {}) {
  if (!btn || typeof fn !== 'function') return await fn();
  if (btn.dataset.tvhSaving === '1') return;
  btn.dataset.tvhSaving = '1';
  const wasDisabled = btn.disabled;
  const originalChildren = Array.from(btn.childNodes);
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  for (const c of originalChildren) btn.removeChild(c);
  const ring = document.createElement('span');
  ring.className = 'tvh-saving-ring';
  ring.setAttribute('aria-hidden', 'true');
  btn.appendChild(ring);
  if (savingLabel) {
    const label = document.createElement('span');
    label.style.marginLeft = '8px';
    label.textContent = savingLabel;
    btn.appendChild(label);
  }
  const endBusy = busy.start(busyLabel);
  try {
    return await fn();
  } finally {
    endBusy();
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    for (const c of originalChildren) btn.appendChild(c);
    btn.disabled = wasDisabled;
    btn.removeAttribute('aria-busy');
    delete btn.dataset.tvhSaving;
  }
}
