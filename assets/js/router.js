/* Hash-based router. Works on GitHub Pages (no server rewrites needed).
 * Registers views; the app decides which view to render on each hashchange.
 */
'use strict';

const routes = new Map();
let notFound = null;

export function register(path, view) { routes.set(path, view); }
export function fallback(view) { notFound = view; }

export function currentPath() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  return { path, params };
}

export function navigate(path) {
  if (!path.startsWith('#')) path = '#' + (path.startsWith('/') ? path : '/' + path);
  if (location.hash === path) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = path;
}

export function start(onRoute) {
  const dispatch = () => {
    const { path, params } = currentPath();
    let handler = routes.get(path);
    let match = {};
    if (!handler) {
      for (const [pattern, fn] of routes.entries()) {
        if (!pattern.includes(':')) continue;
        const partsP = pattern.split('/');
        const partsA = path.split('/');
        if (partsP.length !== partsA.length) continue;
        const m = {};
        let ok = true;
        for (let i = 0; i < partsP.length; i++) {
          if (partsP[i].startsWith(':')) m[partsP[i].slice(1)] = decodeURIComponent(partsA[i]);
          else if (partsP[i] !== partsA[i]) { ok = false; break; }
        }
        if (ok) { handler = fn; match = m; break; }
      }
    }
    if (!handler) handler = notFound;
    onRoute && onRoute(path);
    handler && handler({ path, params, match });
  };
  window.addEventListener('hashchange', dispatch);
  window.addEventListener('DOMContentLoaded', dispatch, { once: true });
  if (document.readyState !== 'loading') dispatch();
}
