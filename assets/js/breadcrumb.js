/* Breadcrumb trail — derives from the current hash route and, where
 * possible, resolves human-friendly labels via the local state (event
 * titles, receipt IDs, etc.). Feature-gated by
 * `society.ui.breadcrumbs` (default: true). */
'use strict';

import { state, getSociety } from './store.js';

const SEGMENT_LABELS = {
  '/':           'Home',
  '/events':     'Events',
  '/reports':    'Reports',
  '/admin':      'Admin',
  '/settings':   'Settings',
  '/audit':      'Audit',
  '/verify':     'Verify',
  '/login':      'Sign in',
  '/contribute': 'Contribute',
  '/backup':     'Backups',
  '/receipt':    'Receipt',
  '/help':       'Help',
  '/e':          'Event',
};

function segmentsFromHash(hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const clean = raw.split('?')[0].split('#')[0];
  const parts = clean.split('/').filter(Boolean);
  return parts;
}

function labelForParts(parts) {
  const chain = [{ href: '#/', label: 'Home' }];
  if (!parts.length) return chain;
  const first = '/' + parts[0];
  const evts  = () => { try { return state.events(); } catch (_e) { return []; } };
  const cbs   = () => { try { return state.contribs(); } catch (_e) { return []; } };

  if (first === '/e' && parts[1]) {
    const evt = evts().find(e => e && e.id === parts[1]);
    chain.push({ href: '#/events', label: 'Events' });
    chain.push({ href: null, label: (evt && evt.title) || 'Event' });
    return chain;
  }
  if (first === '/receipt' && parts[1]) {
    const c = cbs().find(x => x && x.id === parts[1]);
    const evt = c && evts().find(e => e && e.id === c.event);
    chain.push({ href: '#/events', label: 'Events' });
    if (evt) chain.push({ href: `#/e/${evt.id}`, label: evt.title || 'Event' });
    chain.push({ href: null, label: 'Receipt' });
    return chain;
  }
  const label = SEGMENT_LABELS[first] || first.slice(1).replace(/-/g, ' ');
  chain.push({ href: null, label: label.charAt(0).toUpperCase() + label.slice(1) });
  return chain;
}

async function isEnabled() {
  try {
    const soc = await getSociety();
    if (!soc || !soc.ui) return true; // default on
    if (soc.ui.breadcrumbs === false) return false;
    return true;
  } catch (_e) { return true; }
}

function ensureHost() {
  let host = document.getElementById('tvh-breadcrumb');
  if (host) return host;
  host = document.createElement('nav');
  host.id = 'tvh-breadcrumb';
  host.className = 'tvh-breadcrumb';
  host.setAttribute('aria-label', 'Breadcrumb');
  const main = document.getElementById('main');
  if (main && main.parentNode) main.parentNode.insertBefore(host, main);
  else document.body.appendChild(host);
  return host;
}

async function render() {
  const host = ensureHost();
  if (!(await isEnabled())) { host.hidden = true; host.textContent = ''; return; }
  const parts = segmentsFromHash(window.location.hash);
  const chain = labelForParts(parts);
  if (chain.length <= 1) { host.hidden = true; host.textContent = ''; return; }
  host.hidden = false;
  host.textContent = '';
  const ol = document.createElement('ol');
  ol.className = 'tvh-breadcrumb-list';
  chain.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'tvh-breadcrumb-item' + (i === chain.length - 1 ? ' is-current' : '');
    if (item.href && i < chain.length - 1) {
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      li.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.textContent = item.label;
      if (i === chain.length - 1) span.setAttribute('aria-current', 'page');
      li.appendChild(span);
    }
    ol.appendChild(li);
  });
  host.appendChild(ol);
}

export function installBreadcrumb() {
  if (installBreadcrumb._wired) return;
  installBreadcrumb._wired = true;
  window.addEventListener('hashchange', () => { render().catch(() => {}); });
  render().catch(() => {});
}

export function refreshBreadcrumb() { render().catch(() => {}); }
