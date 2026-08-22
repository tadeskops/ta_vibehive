/* SPA bootstrap — wire chrome, register routes, dispatch. */
'use strict';
import { $, el, clear } from './dom.js';
import * as router from './router.js';
import { session, bindGis } from './auth.js';
import { can } from './rbac.js';
import { getSociety, state } from './store.js';
import { installFetchWrapper } from './busy.js';
import { mountBell as mountNotifyBell } from './notify.js';

/* Global background-activity tracker: wraps window.fetch so every network
 * call (Google Identity Services, GitHub archive push, config load, …)
 * automatically drives the topbar's golden shimmer stripe. Idempotent —
 * safe to call once. */
installFetchWrapper();

/* Bootstrap Google Identity Services (GIS). Mirrors the ta-society-helpdesk
 * pattern (docs/index.html → Auth.init). If TVH_GOOGLE_CLIENT_ID isn't set
 * (contributor / test build), the shim isn't initialised and the login view
 * falls back to the demo persona picker. */
(async function bootAuth() {
  try {
    const cid = (typeof window !== 'undefined' && window.TVH_GOOGLE_CLIENT_ID) || '';
    if (!cid || !window.Auth || typeof window.Auth.init !== 'function') return;
    // Attach the session bridge BEFORE init so an auto-restored JWT reaches
    // the app store on first tick.
    bindGis();
    await window.Auth.init({ clientId: cid });
  } catch (e) { console.warn('GIS init failed', e); }
})();

/* View modules (lazy for first-paint gzip budget) */
const views = {
  home:       () => import('./views/home.js'),
  events:     () => import('./views/events.js'),
  event:      () => import('./views/event.js'),
  contribute: () => import('./views/contribute.js'),
  admin:      () => import('./views/admin.js'),
  settings:   () => import('./views/settings.js'),
  reports:    () => import('./views/reports.js'),
  receipt:    () => import('./views/receipt.js'),
  verify:     () => import('./views/verify.js'),
  login:      () => import('./views/login.js'),
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
router.register('/settings',                  (ctx) => mountView(views.settings, { ...ctx, match: { tab: 'attributes' } }));
router.register('/settings/:tab',             (ctx) => mountView(views.settings, ctx));
router.register('/reports',                   (ctx) => mountView(views.reports, ctx));
router.register('/receipt/:id',               (ctx) => mountView(views.receipt, ctx));
router.register('/verify',                    (ctx) => mountView(views.verify, ctx));
router.register('/verify/:id',                (ctx) => mountView(views.verify, ctx));
router.register('/login',                     (ctx) => mountView(views.login, ctx));
router.fallback(                              (ctx) => mountView(views.home, ctx));

/* Inline stroke-icon SVG — visual equivalent of ta-society-helpdesk's
 * FontAwesome fa-right-to-bracket. Matches the header download / bell
 * icons' stroke weight so the toolbar reads as one icon family. */
const ICON_SIGNIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16">' +
    '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>' +
    '<polyline points="10 17 15 12 10 7"/>' +
    '<line x1="15" x2="3" y1="12" y2="12"/>' +
  '</svg>';
function iconSpan(svg) {
  const s = document.createElement('span');
  s.className = 'btn-ico';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = svg;
  return s;
}

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
  const showAdmin    = user && await can(user, 'features.registry.edit');
  const showSettings = user && await can(user, 'settings.view');
  const showReports  = user && await can(user, 'reports.view');
  if (version !== renderChrome.__v) return;
  if (showReports)  links.push({ href: '#/reports', text: 'Reports' });
  if (showSettings) links.push({ href: '#/settings', text: 'Settings' });
  if (showAdmin)    links.push({ href: '#/admin', text: 'Admin' });
  clear(nav); clear(whoami);
  const hash = location.hash || '#/';
  for (const l of links) {
    const a = el('a', { href: l.href, text: l.text });
    if (hash === l.href || (l.href !== '#/' && hash.startsWith(l.href))) a.classList.add('active');
    nav.append(a);
  }

  if (user) {
    /* Notifications bell — sits to the LEFT of the whoami pill so the
     * unread badge is the first thing a signed-in resident's eye lands
     * on when a new event is published or a receipt is issued. */
    mountNotifyBell(whoami);
    /* Admin export report — same `.tvh-icon-btn` skin as the bell so
     * the header cluster reads as ONE uniform toolbar. Gated on
     * `reports.export` (admin / mgmt). Downloads a client-side CSV of
     * every contribution across every event — no data leaves the
     * browser, no external service is contacted. */
    if (await can(user, 'reports.export')) {
      if (version !== renderChrome.__v) return;
      const btn = el('button', {
        type: 'button',
        class: 'tvh-icon-btn',
        'aria-label': 'Export contributions report (CSV)',
        title: 'Export contributions report (CSV)'
      });
      /* Download-arrow SVG — matches the IG / bell stroke weight so
       * every icon in the cluster has the same visual weight. */
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        try { downloadContribsCsv(user); }
        catch (e) { console.error('[export] failed', e); }
      });
      whoami.append(btn);
    }
    const roleLabel = ({ admin: 'Admin', mgmt: 'MC', committee: 'Committee', manager: 'Manager', resident: 'Resident' })[user.role] || user.role;
    whoami.append(el('span', { class: 'whoami' },
      el('span', { class: 'avatar', text: (user.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase() }),
      el('span', { class: 'whoami-name', text: user.name.split(' ')[0] }),
      el('span', { class: 'role-badge ' + ({ admin: '', mgmt: 'mc', committee: 'cmt', manager: 'mgr', resident: 'res' })[user.role], text: roleLabel })
    ));
    whoami.append(el('a', { class: 'btn btn-sm btn-ghost', href: '#/login' },
      iconSpan(ICON_SIGNIN), el('span', { text: 'Switch' })));
  } else {
    whoami.append(el('a', { class: 'btn btn-sm', href: '#/login' },
      iconSpan(ICON_SIGNIN), el('span', { text: 'Sign in' })));
  }

  /* Mobile tab-bar: highlight the active tab + adjust the "Me" link. */
  syncMobileTabbar(user);
}

/* Mark the mobile tab that matches the current hash. Also swaps the
 * "Me" tab between #/login and #/admin depending on role, so admins
 * one-tap into the admin console from the tab-bar. */
function syncMobileTabbar(user) {
  const hash = location.hash || '#/';
  const tabbar = document.getElementById('tvhTabbar');
  if (!tabbar) return;
  const me = document.getElementById('tvhTabMe');
  if (me) {
    if (user && (user.role === 'admin' || user.role === 'mgmt')) me.href = '#/admin';
    else me.href = '#/login';
  }
  const anchors = tabbar.querySelectorAll('a[data-tab]');
  anchors.forEach(a => {
    const h = a.getAttribute('href') || '';
    const on = h === '#/' ? hash === '#/' : hash.startsWith(h);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    a.classList.toggle('is-active', on);
  });
}

/* Bottom-sheet wiring — WhatsApp-style. Populated on open so the
 * admin item appears / disappears with role changes without needing
 * a page reload. Closes on backdrop tap, X-button, Escape, or when
 * any item inside is tapped (letting the router take over). */
function mountSheet() {
  const fab   = document.getElementById('tvhFab');
  const back  = document.getElementById('tvhSheetBack');
  const sheet = document.getElementById('tvhSheet');
  const list  = document.getElementById('tvhSheetList');
  if (!fab || !back || !sheet || !list || sheet.__wired) return;
  sheet.__wired = true;
  const closeBtn = sheet.querySelector('.tvh-sheet-close');

  async function populate() {
    const user = session();
    /* Sheet is now a focused two-action launcher: create + contribute.
     * "New event" is gated on `events.create` (admin/mgmt/committee).
     * "Add contribution" always goes to /events so the resident picks
     * the event tile they want to give to - the tile has an inline
     * "＋ Contribute" button that deep-links straight into the form.
     * Verify / Sign-in / Admin already live in the tab-bar and topnav. */
    const items = [];
    if (user && await can(user, 'events.create')) {
      items.push({ href: '#/events', ico: '🎉', label: 'Create a new event', sub: 'Pick a template · publish when ready',
        onClick: () => { try { sessionStorage.setItem('tvh:new-event', '1'); } catch (_e) {} } });
    }
    items.push({ href: '#/events', ico: '💛', label: 'Add a contribution', sub: user ? 'Pick an event and give' : 'Sign in when you contribute' });
    clear(list);
    for (const it of items) {
      const anchor = el('a', { href: it.href },
        el('span', { class: 'ico', 'aria-hidden': 'true', text: it.ico }),
        el('span', {}, el('span', { text: it.label }),
          it.sub ? el('span', { class: 'sub', text: it.sub }) : null)
      );
      if (it.onClick) anchor.addEventListener('click', it.onClick);
      list.append(el('li', {}, anchor));
    }
  }

  function open() {
    populate();
    back.hidden = false; sheet.hidden = false;
    /* two-frame delay so the transition actually plays */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      back.classList.add('is-open'); sheet.classList.add('is-open');
    }));
    fab.setAttribute('aria-expanded', 'true');
    sheet.setAttribute('aria-hidden', 'false');
  }
  function close() {
    back.classList.remove('is-open'); sheet.classList.remove('is-open');
    fab.setAttribute('aria-expanded', 'false');
    sheet.setAttribute('aria-hidden', 'true');
    setTimeout(() => { back.hidden = true; sheet.hidden = true; }, 220);
  }
  fab.addEventListener('click', () => (fab.getAttribute('aria-expanded') === 'true' ? close() : open()));
  back.addEventListener('click', close);
  closeBtn && closeBtn.addEventListener('click', close);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  list.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  window.addEventListener('hashchange', () => { if (!sheet.hidden) close(); });
}

/* Floating "Back to top" button — visible once the user has scrolled
 * past ~320 px, smooth-scrolls to the top (or jumps directly if
 * prefers-reduced-motion is on). Rendered once per session; scoped to
 * both desktop and mobile via CSS. Same pattern shipped in tsh's
 * ui.js#bindHeader so the two apps behave identically. */
function mountBackToTop() {
  if (document.querySelector('.tvh-backtotop')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tvh-backtotop';
  btn.setAttribute('aria-label', 'Back to top');
  btn.setAttribute('title', 'Back to top');
  btn.textContent = '↑';
  btn.addEventListener('click', () => {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  });
  document.body.appendChild(btn);
  const onScroll = () => {
    const y = window.scrollY || window.pageYOffset || 0;
    btn.classList.toggle('is-visible', y > 320);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

router.start(() => renderChrome());
window.addEventListener('DOMContentLoaded', async () => {
  $('#year').textContent = String(new Date().getFullYear());
  renderChrome();
  mountSheet();
  mountBackToTop();
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
    /* Mobile-only Instagram shortcut in the header. Same source of
     * truth as the footer pill; kept hidden when no handle is set so
     * a fresh install doesn't ship a dead link at the top-right. */
    const headerIg = document.getElementById('tvhHeaderIg');
    if (headerIg && url) {
      headerIg.href = url;
      if (socialCfg.label) headerIg.setAttribute('aria-label', 'Follow ' + socialCfg.label + ' on Instagram');
      headerIg.hidden = false;
    }
  } catch (_e) { /* keep shipped fallback */ }
});

/* ---------- Contributions CSV export ----------
 * Client-side download of a spreadsheet-friendly report. Gated on
 * `reports.export` (admin / mgmt) at the call-site — the function
 * itself does no auth check because the header button never appears
 * for other roles. All data comes from localStorage; nothing leaves
 * the browser. Fields are RFC 4180 escaped (double quotes doubled;
 * every cell wrapped in quotes) so commas / newlines / quotes in a
 * remark or name never desync the columns. */
function downloadContribsCsv(user) {
  const events = state.events();
  const eventById = new Map(events.map(e => [e.id, e]));
  const contribs = state.contribs();
  const columns = [
    'contribution_id', 'created_at', 'verified_at', 'status',
    'event_id', 'event_title', 'event_status',
    'contributor_name', 'contributor_email', 'contributor_mobile',
    'flat', 'amount', 'method', 'ref',
    'anonymous', 'hide_amount',
    'on_behalf', 'filled_by_name', 'filled_by_email',
    'proof_attached', 'remarks',
  ];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = [columns.map(esc).join(',')];
  for (const c of contribs) {
    const evt = eventById.get(c.event) || {};
    rows.push([
      c.id, c.created_at || '', c.verified_at || '', c.status || '',
      c.event || '', evt.title || '', evt.status || '',
      c.contributor_name || '', c.contributor_email || '', c.contributor_mobile || '',
      c.flat || '', c.amount || 0, c.method || '', c.ref || '',
      c.anonymous ? 'yes' : 'no', c.hide_amount ? 'yes' : 'no',
      c.on_behalf ? 'yes' : 'no', c.filled_by_name || '', c.filled_by_email || '',
      c.proof_data_url ? 'yes' : 'no', c.remarks || '',
    ].map(esc).join(','));
  }
  /* BOM lets Excel auto-detect UTF-8 so ₹ symbols and Devanagari
   * names in remarks render correctly without a manual reimport. */
  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vibehive-contributions-${stamp}.csv`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  try { state.audit({ actor: user ? user.id : null, action: 'report.export', rows: contribs.length }); }
  catch (_e) { /* audit failure never blocks the download */ }
}
