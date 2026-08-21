/* SPA bootstrap — wire chrome, register routes, dispatch. */
'use strict';
import { $, el, clear } from './dom.js';
import * as router from './router.js';
import { session } from './auth.js';
import { can } from './rbac.js';
import { isCallbackHit } from './auth-oauth.js';

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
  clear(nav); clear(whoami);
  const user = session();

  const links = [
    { href: '#/', text: 'Home' },
    { href: '#/events', text: 'Events' },
    { href: '#/verify', text: 'Verify receipt' },
  ];
  if (user && await can(user, 'features.registry.edit')) links.push({ href: '#/admin', text: 'Admin' });
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
window.addEventListener('DOMContentLoaded', () => {
  $('#year').textContent = String(new Date().getFullYear());
  renderChrome();
});
