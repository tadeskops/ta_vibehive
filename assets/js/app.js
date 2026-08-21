/* SPA bootstrap — wire chrome, register routes, dispatch. */
'use strict';
import { $, el, clear } from './dom.js';
import * as router from './router.js';
import { session } from './auth.js';
import { can } from './rbac.js';
import { isCallbackHit } from './auth-oauth.js';
import { getSociety } from './store.js';
import { installFetchWrapper } from './busy.js';

/* Global background-activity tracker: wraps window.fetch so every network
 * call (OAuth, GitHub archive push, config load, …) automatically drives
 * the topbar's golden shimmer stripe. Idempotent — safe to call once. */
installFetchWrapper();

/* If the browser landed on the OAuth redirect_uri (root + ?code=&state=),
 * hand off to the callback view. Rewrites the URL into a hash route so the
 * router picks it up in the normal dispatch. */
if (isCallbackHit()) {
  const q = new URLSearchParams(location.search);
  const preserved = new URLSearchParams({ code: q.get('code'), state: q.get('state') });
  history.replaceState({}, '', location.pathname);
  location.hash = '#/auth/callback?' + preserved.toString();
}

/* View modules (lazy for first-paint gzip budget) */
const views = {
  home:       () => import('./views/home.js'),
  events:     () => import('./views/events.js'),
  event:      () => import('./views/event.js'),
  contribute: () => import('./views/contribute.js'),
  admin:      () => import('./views/admin.js'),
  receipt:    () => import('./views/receipt.js'),
  verify:     () => import('./views/verify.js'),
  login:      () => import('./views/login.js'),
  authcb:     () => import('./views/auth-callback.js'),
};

async function mountView(loader, ctx) {
  const root = $('#main');
  clear(root);
  root.append(el('div', { class: 'sub', text: 'Loading…' }));
  const mod = await loader();
  await mod.render(root, ctx || {});
}

router.register('/',                          (ctx) => mountView(views.home, ctx));
router.register('/events',                    (ctx) => mountView(views.events, ctx));
router.register('/e/:id',                     (ctx) => mountView(views.event, ctx));
router.register('/e/:id/edit',                (ctx) => mountView(views.event, { ...ctx, match: { ...ctx.match, mode: 'edit' } }));
router.register('/e/:id/manage',              (ctx) => mountView(views.event, { ...ctx, match: { ...ctx.match, mode: 'manage' } }));
router.register('/e/:id/contribute',          (ctx) => mountView(views.contribute, ctx));
router.register('/e/:id/register',            (ctx) => mountView(views.contribute, ctx));
router.register('/admin',                     (ctx) => mountView(views.admin, { ...ctx, match: { tab: 'features' } }));
router.register('/admin/:tab',                (ctx) => mountView(views.admin, ctx));
router.register('/receipt/:id',               (ctx) => mountView(views.receipt, ctx));
router.register('/verify',                    (ctx) => mountView(views.verify, ctx));
router.register('/verify/:id',                (ctx) => mountView(views.verify, ctx));
router.register('/login',                     (ctx) => mountView(views.login, ctx));
router.register('/auth/callback',             (ctx) => mountView(views.authcb, ctx));
router.fallback(                              (ctx) => mountView(views.home, ctx));

async function renderChrome() {
  const nav = $('#topnav');
  const whoami = $('#whoami');
  const user = session();

  const links = [
    { href: '#/', text: 'Home' },
    { href: '#/events', text: 'Events' },
    { href: '#/verify', text: 'Verify receipt' },
  ];
  /* IMPORTANT: this call is async → concurrent invocations of renderChrome
   * (router.start + DOMContentLoaded + first hashchange) can otherwise
   * race and each append after the await, tripling the visible nav.
   * We tag the invocation with a version and clear+repopulate only if
   * we're still the latest caller when can() resolves. */
  const version = (renderChrome.__v = (renderChrome.__v || 0) + 1);
  const showAdmin = user && await can(user, 'features.registry.edit');
  if (version !== renderChrome.__v) return;
  if (showAdmin) links.push({ href: '#/admin', text: 'Admin' });
  clear(nav); clear(whoami);
  const hash = location.hash || '#/';
  for (const l of links) {
    const a = el('a', { href: l.href, text: l.text });
    if (hash === l.href || (l.href !== '#/' && hash.startsWith(l.href))) a.classList.add('active');
    nav.append(a);
  }

  if (user) {
    whoami.append(el('span', { class: 'whoami' },
      el('span', { class: 'avatar', text: (user.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase() }),
      el('span', { text: user.name.split(' ')[0] }),
      el('span', { class: 'role-badge ' + ({ admin: '', mgmt: 'mc', committee: 'cmt', manager: 'mgr', resident: 'res' })[user.role], text: user.role })
    ));
    whoami.append(el('a', { class: 'btn btn-sm btn-ghost', href: '#/login' }, 'Switch'));
  } else {
    whoami.append(el('a', { class: 'btn btn-sm', href: '#/login' }, 'Sign in'));
  }
}

router.start(() => renderChrome());
window.addEventListener('DOMContentLoaded', async () => {
  $('#year').textContent = String(new Date().getFullYear());
  renderChrome();
  /* Society sub-line under the VibeHive wordmark. Reads through
   * getSociety() so admin overrides show up immediately. */
  try {
    const soc = await getSociety();
    const sub = document.querySelector('[data-brand-society]');
    if (sub && soc && soc.short_name) {
      const where = (soc.location || '').split(',')[0].trim();
      sub.textContent = where ? `${soc.short_name} · ${where}` : soc.short_name;
    }
    /* Footer legal-name hydration (short-form English name so the row
     * doesn't wrap). Falls back to the shipped literal on failure. */
    const legal = document.querySelector('[data-brand-society-full]');
    if (legal && soc && (soc.english_name || soc.short_name)) {
      legal.textContent = soc.english_name || soc.short_name;
    }
    /* Footer social pill hydration. Reads society.social.instagram (or
     * whatsapp) — reveals the pill only when a URL is configured, so a
     * fresh install doesn't show a dead link. */
    const socialLink = document.getElementById('footpad-social');
    const socialCfg = (soc && soc.social) || {};
    const url = socialCfg.instagram || socialCfg.whatsapp || '';
    if (socialLink && url) {
      socialLink.href = url;
      const label = socialLink.querySelector('[data-footpad-social-label]');
      if (label && socialCfg.label) label.textContent = socialCfg.label;
      socialLink.hidden = false;
    }
  } catch (_e) { /* keep shipped fallback */ }
});
