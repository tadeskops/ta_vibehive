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
