/* SPA bootstrap — wire chrome, register routes, dispatch. */
'use strict';
import { $, el, clear, modal, toast } from './dom.js';
import * as router from './router.js';
import { session, bindGis, logout } from './auth.js';
import { can } from './rbac.js';
import { getSociety, state } from './store.js';
import { installFetchWrapper, busy } from './busy.js';
import { mountBell as mountNotifyBell } from './notify.js';
import { syncFromWorker, installAutoRefresh } from './sync.js';
import { mountVisitCounter } from './visit-counter.js';
import { installLongPressTooltips } from './longpress-tooltip.js';
import { installBreadcrumb } from './breadcrumb.js';
import { wireAboutTriggers } from './about-modal.js';

/* Global background-activity tracker: wraps window.fetch so every network
 * call (Google Identity Services, GitHub archive push, config load, …)
 * automatically drives the topbar's golden shimmer stripe. Idempotent —
 * safe to call once. */
installFetchWrapper();

/* Boot-time sync: hydrate the local events cache from the Worker so
 * multi-device viewing works (any user sees the current published
 * event list, not just what their own browser last cached). Fire-and-
 * forget — never blocks the first paint. See assets/js/sync.js. */
syncFromWorker();
/* Auto-refresh: pull /events + /contributions + /settings again when
 * the tab returns to the foreground and once every 60 s while
 * visible. Throttled to at most one call per 20 s. Provides the
 * "background glow-progress" the user asked for via the existing
 * topbar shimmer that fires on every fetch. */
installAutoRefresh();
/* Footer visit-count chip — anonymous, best-effort. No-op when the
 * `metrics.visitor_counter` system flag is OFF (default). */
mountVisitCounter();

/* Global "return to previous view after sign-in" — any anchor pointing
 * at `#/login` (without an explicit `next`) is intercepted so the
 * current hash is preserved. The login page already honours `?next=`.
 * Uses capture phase so it wins over router link handling. */
if (typeof document !== 'undefined') {
  document.addEventListener('click', (ev) => {
    const a = ev.target && ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;
    const href = String(a.getAttribute('href') || '');
    if (href !== '#/login' && href !== '#/login/') return;
    const cur = location.hash || '#/';
    if (cur === '#/login' || cur.startsWith('#/login')) return;
    ev.preventDefault();
    location.hash = '#/login?next=' + encodeURIComponent(cur);
  }, true);
}

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
  me:         () => import('./views/me.js'),
};

async function mountView(loader, ctx) {
  const endBusy = busy.start('Loading view…');
  const root = $('#main');
  try {
    clear(root);
    root.append(el('div', { class: 'sub', text: 'Loading…' }));
    const mod = await loader();
    await mod.render(root, ctx || {});
  } finally {
    endBusy();
  }
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
router.register('/reports/event/:id',         (ctx) => mountView(views.reports, ctx));
router.register('/receipt/:id',               (ctx) => mountView(views.receipt, ctx));
router.register('/verify',                    (ctx) => mountView(views.verify, ctx));
router.register('/verify/:id',                (ctx) => mountView(views.verify, ctx));
router.register('/login',                     (ctx) => mountView(views.login, ctx));
router.register('/me',                        (ctx) => mountView(views.me, ctx));
router.fallback(                              (ctx) => mountView(views.home, ctx));

/* Auth icons intentionally mirror TSH semantics:
 * - Sign in: right-to-bracket
 * - Sign out: right-from-bracket */
const ICON_SIGNIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16">' +
    '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>' +
    '<polyline points="10 17 15 12 10 7"/>' +
    '<line x1="15" x2="3" y1="12" y2="12"/>' +
  '</svg>';
const ICON_SIGNOUT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16">' +
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
    '<polyline points="16 17 21 12 16 7"/>' +
    '<line x1="21" x2="9" y1="12" y2="12"/>' +
  '</svg>';
const SVG_NS = 'http://www.w3.org/2000/svg';
function buildSvgIcon(kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const add = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    svg.appendChild(n);
  };
  if (kind === 'signin') {
    add('path', { d: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4' });
    add('polyline', { points: '10 17 15 12 10 7' });
    add('line', { x1: '15', x2: '3', y1: '12', y2: '12' });
    return svg;
  }
  if (kind === 'signout') {
    add('path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' });
    add('polyline', { points: '16 17 21 12 16 7' });
    add('line', { x1: '21', x2: '9', y1: '12', y2: '12' });
    return svg;
  }
  add('path', { d: 'M12 3v12' });
  add('path', { d: 'm7 10 5 5 5-5' });
  add('path', { d: 'M5 21h14' });
  return svg;
}
function iconSpan(svg) {
  const s = document.createElement('span');
  s.className = 'btn-ico';
  s.setAttribute('aria-hidden', 'true');
  s.append(buildSvgIcon(svg === ICON_SIGNIN ? 'signin' : 'signout'));
  return s;
}

/* Header-icon shortcut for generating a report:
 * opens a lightweight event picker so admins can jump straight to a
 * scoped PDF report without opening the full Reports view first.
 * The picker writes the chosen scope into the same localStorage key
 * (`tvh:v1:reports:filters`) that `views/reports.js` reads on mount,
 * so the reports page renders with the events pre-selected. */
const REPORTS_FILTER_KEY = 'tvh:v1:reports:filters';
function openReportScopeModal() {
  const events = [...state.events()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  /* Load the current filter blob so we preserve every other setting
   * (statuses / columns / groupBy) and only overwrite scope+eventIds. */
  let current = {};
  try { current = JSON.parse(localStorage.getItem(REPORTS_FILTER_KEY) || '{}') || {}; } catch (_e) { /* ignore */ }
  const preselected = new Set(Array.isArray(current.eventIds) ? current.eventIds : []);
  const picks = new Set(preselected);
  const groupLabel = (e) => ({ published: 'Live', closed: 'Closed', archived: 'Archived', draft: 'Drafts', review: 'Pending approval' })[e.status] || 'Other';
  const grouped = new Map();
  for (const e of events) {
    const g = groupLabel(e);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(e);
  }
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:10px;max-height:52vh;overflow-y:auto' });
  for (const [group, items] of grouped) {
    const groupWrap = el('div', {},
      el('div', { class: 'lbl', style: 'font-weight:700;margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)', text: group }),
      ...items.map((e) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = picks.has(e.id);
        cb.addEventListener('change', () => {
          if (cb.checked) picks.add(e.id); else picks.delete(e.id);
        });
        return el('label', { style: 'display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--line);border-radius:8px;cursor:pointer' },
          cb,
          el('span', {},
            el('div', { style: 'font-weight:600', text: `${e.glyph || '📌'} ${e.title || e.id}` }),
            el('small', { class: 'sub', text: `${e.template || 'event'} · ${e.status || 'draft'}` })
          )
        );
      })
    );
    list.append(groupWrap);
  }
  const summaryLine = el('p', { class: 'sub', style: 'margin:0 0 8px', text: `${events.length} event${events.length === 1 ? '' : 's'} on record. Tick the ones to include in the PDF.` });
  const emptyNote = !events.length ? el('p', { class: 'sub', text: 'No events on record yet — create one first.' }) : null;
  modal({
    title: '↓ Generate report — pick events',
    body: el('div', {}, summaryLine, emptyNote || list),
    actions: [
      { label: 'All published events', kind: 'btn-ghost', onClick: (close) => {
        const blob = { ...current, scope: 'published', eventIds: [] };
        try { localStorage.setItem(REPORTS_FILTER_KEY, JSON.stringify(blob)); } catch (_e) { /* quota */ }
        close();
        location.hash = '#/reports';
      } },
      { label: 'Cancel', close: true },
      { label: 'Open report →', kind: '', onClick: (close) => {
        const chosen = Array.from(picks);
        if (!chosen.length) { toast('Pick at least one event, or use "All published events".', 'warn'); return; }
        const blob = { ...current, scope: 'events', eventIds: chosen };
        try { localStorage.setItem(REPORTS_FILTER_KEY, JSON.stringify(blob)); } catch (_e) { /* quota */ }
        close();
        location.hash = '#/reports';
      } }
    ]
  });
}

async function renderChrome() {
  const nav = $('#topnav');
  const whoami = $('#whoami');
  const user = session();
  const soc = await getSociety();
  const showVerify = !!(((soc || {}).navigation || {}).show_verify);

  const links = [
    { href: '#/', text: 'Home' },
    { href: '#/events', text: 'Events' },
  ];
  if (user) links.push({ href: '#/me', text: 'My Ledger' });
  if (showVerify) links.push({ href: '#/verify', text: 'Verify receipt' });
  /* IMPORTANT: this call is async → concurrent invocations of renderChrome
   * (router.start + DOMContentLoaded + first hashchange) can otherwise
   * race and each append after the await, tripling the visible nav.
   * We tag the invocation with a version and clear+repopulate only if
   * we're still the latest caller when can() resolves. */
  const version = (renderChrome.__v = (renderChrome.__v || 0) + 1);
  const [showAdmin, showSettings, showReports, canExport, canPublish, canVerify, canCreate] = user
    ? await Promise.all([
      can(user, 'features.registry.edit'),
      can(user, 'settings.view'),
      can(user, 'reports.view'),
      can(user, 'reports.export'),
      can(user, 'events.publish'),
      can(user, 'contributions.verify'),
      can(user, 'events.create'),
    ])
    : [false, false, false, false, false, false, false];
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
    /* Admin report action — same `.tvh-icon-btn` skin as the bell so
     * the header cluster reads as ONE uniform toolbar. Gated on
     * `reports.export` (admin / mgmt / secretary). Routes to the
     * Reports surface where PDF download + archive actions live. */
    if (canExport) {
      if (version !== renderChrome.__v) return;
      const btn = el('button', {
        type: 'button',
        class: 'tvh-icon-btn tvh-export-btn',
        'aria-label': 'Open reports (PDF)',
        title: 'Open reports (PDF)'
      });
      /* Download-arrow SVG — matches the IG / bell stroke weight so
       * every icon in the cluster has the same visual weight. */
      btn.append(buildSvgIcon('download'));
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        try { openReportScopeModal(); }
        catch (e) { console.error('[export] failed', e); location.hash = '#/reports'; }
      });
      whoami.append(btn);
    }
    const roleLabel = ({ admin: 'Admin', secretary: 'Secretary', mgmt: 'MC', committee: 'Committee', manager: 'Manager', resident: 'Resident' })[user.role] || user.role;
    /* Persona chip doubles as the entry point to the user's own
     * activity view (contributions + expenses + receipt links). */
    whoami.append(el('a', { class: 'whoami', href: '#/me', title: 'Your contributions & expenses', style: 'text-decoration:none' },
      el('span', { class: 'avatar', text: (user.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase() }),
      el('span', { class: 'whoami-name', text: user.name.split(' ')[0] }),
      el('span', { class: 'role-badge ' + ({ admin: '', secretary: 'sec', mgmt: 'mc', committee: 'cmt', manager: 'mgr', resident: 'res' })[user.role], text: roleLabel }),
      user.is_verified_resident ? el('span', { class: 'pill pill-sage', title: 'Verified resident email', text: '🛡' }) : null
    ));
    const signOutBtn = el('button', { class: 'btn btn-sm btn-ghost btn-auth btn-auth-signout', type: 'button' },
      iconSpan(ICON_SIGNOUT),
      el('span', { class: 'btn-label', text: 'Sign out' })
    );
    signOutBtn.addEventListener('click', () => {
      try { logout(); }
      catch (_e) { /* ignore */ }
      location.reload();
    });
    whoami.append(signOutBtn);
  } else {
    whoami.append(el('a', { class: 'btn btn-sm btn-auth btn-auth-signin', href: '#/login' },
      iconSpan(ICON_SIGNIN),
      el('span', { class: 'btn-label', text: 'Sign in' })
    ));
  }

  /* Mobile tab-bar: highlight the active tab + adjust the "Me" link. */
  syncMobileTabbar(user, showVerify);
  await applyFooterDesktopVisibility();
}

async function applyFooterDesktopVisibility() {
  try {
    const soc = await getSociety();
    const desk = ((soc.footer || {}).desktop) || {};
    const showVerify = !!(((soc || {}).navigation || {}).show_verify);
    const isDesktop = window.matchMedia && window.matchMedia('(min-width: 641px)').matches;
    const setFoot = (id, show) => {
      const n = document.getElementById(id);
      if (!n) return;
      if (isDesktop) {
        n.hidden = !show;
        n.style.display = show ? '' : 'none';
      } else {
        n.hidden = false;
        n.style.display = '';
      }
    };
    const setAny = (id, show) => {
      const n = document.getElementById(id);
      if (!n) return;
      n.hidden = !show;
      n.style.display = show ? '' : 'none';
    };
    setFoot('footpad-social', desk.show_social !== false);
    setFoot('footpad-report-btn', desk.show_bug_report !== false);
    /* Keep verify in header/mobile when enabled, but suppress footer verify
     * affordance on desktop to reduce footer clutter. */
    const showFooterVerify = showVerify && !isDesktop;
    setAny('footpad-verify-link', showFooterVerify);
    /* Legal/source meta lines remain desktop-hidden by policy. */
    setFoot('footpad-legal-line', isDesktop ? false : (desk.show_legal !== false));
    setFoot('footpad-source-line', isDesktop ? false : (desk.show_brand_line !== false));
    const showBrandSource = desk.show_brand_source === true;
    const showBrandBuild = desk.show_brand_build === true;
    setAny('footpad-source-link', showBrandSource);
    setAny('footpad-build-text', showBrandBuild);
    /* Dot choreography:
     * - sep1 is used before source OR build (if source is hidden).
     * - sep2 appears only when both source and build are visible. */
    setAny('footpad-sep-brand-source', showBrandSource || showBrandBuild);
    setAny('footpad-sep-source-build', showBrandSource && showBrandBuild);
    const dot = document.getElementById('footpad-center-dot');
    if (dot && isDesktop) {
      const bug = document.getElementById('footpad-report-btn');
      const vrf = document.getElementById('footpad-verify-link');
      dot.hidden = !!(bug && bug.hidden) || !!(vrf && vrf.hidden);
    }
  } catch (_e) { /* best-effort */ }
}

/* Mark the mobile tab that matches the current hash. Also swaps the
 * "Me" tab between #/login and #/admin depending on role, so admins
 * one-tap into the admin console from the tab-bar. */
function syncMobileTabbar(user, showVerify) {
  const hash = location.hash || '#/';
  const tabbar = document.getElementById('tvhTabbar');
  if (!tabbar) return;
  const verify = tabbar.querySelector('a[data-tab="verify"]');
  if (verify) verify.hidden = !showVerify;
  const me = document.getElementById('tvhTabMe');
  if (me) {
    if (user && (user.role === 'admin' || user.role === 'mgmt')) me.href = '#/admin';
    else if (user) me.href = '#/me';
    /* Anonymous visitors: hide the "Me" tab entirely so the header
     * sign-in button is the single entry point to authentication. */
    if (!user) { me.hidden = true; me.style.display = 'none'; }
    else       { me.hidden = false; me.style.display = ''; }
  }
  /* Mobile tab-bar role chip — mirrors the header persona chip so the
   * signed-in role stays visible on small screens. */
  const meLabel = document.getElementById('tvhTabMeLabel');
  const meRole  = document.getElementById('tvhTabMeRole');
  if (meLabel && meRole) {
    if (user) {
      const roleLabelShort = ({ admin: 'Admin', secretary: 'Sec', mgmt: 'MC', committee: 'Cmt', manager: 'Mgr', resident: 'Res' })[user.role] || 'Res';
      const roleTone = ({ admin: '', secretary: 'sec', mgmt: 'mc', committee: 'cmt', manager: 'mgr', resident: 'res' })[user.role] || 'res';
      meLabel.textContent = (user.name || user.email || 'Me').split(' ')[0];
      meRole.textContent = roleLabelShort;
      meRole.className = 'tvh-tab-role role-badge ' + roleTone;
      meRole.hidden = false;
      meRole.style.display = '';
    } else {
      meLabel.textContent = 'Me';
      meRole.textContent = '';
      meRole.hidden = true;
      meRole.style.display = 'none';
    }
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
  /* Temporary product switch: keep stack sheet code in place but bypass
   * its UI so `+` directly routes to event creation. */
  const USE_QUICK_ACTION_STACK_POPUP = false;
  if (!fab || !back || !sheet || !list || sheet.__wired) return;
  sheet.__wired = true;
  fab.hidden = true;
  const closeBtn = sheet.querySelector('.tvh-sheet-close');

  async function populate() {
    const user = session();
    /* Quick action is create-only. Visibility is role/config gated via
     * `events.create` permission (roles.json / RBAC policy). */
    const canCreate = !!(user && await can(user, 'events.create'));
    fab.hidden = !canCreate;
    if (!canCreate) {
      clear(list);
      close();
      return;
    }

    const items = [];
    items.push({ href: '#/events', ico: '🎉', label: 'Create a new event', sub: 'Pick a template · publish when ready',
      onClick: () => { try { sessionStorage.setItem('tvh:new-event', '1'); } catch (_e) {} }
    });
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

  async function open() {
    await populate();
    if (fab.hidden) return;
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
  fab.addEventListener('click', async () => {
    if (!USE_QUICK_ACTION_STACK_POPUP) {
      const user = session();
      const canCreate = !!(user && await can(user, 'events.create'));
      if (!canCreate) {
        fab.hidden = true;
        return;
      }
      try { sessionStorage.setItem('tvh:new-event', '1'); } catch (_e) {}
      location.hash = '#/events';
      return;
    }
    if (fab.getAttribute('aria-expanded') === 'true') close();
    else await open();
  });
  back.addEventListener('click', close);
  closeBtn && closeBtn.addEventListener('click', close);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  list.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  window.addEventListener('hashchange', () => { if (!sheet.hidden) close(); populate(); });
  populate();
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
  installLongPressTooltips();
  installBreadcrumb();
  wireAboutTriggers();
  /* Society sub-line under the VibeHive wordmark. Reads through
   * getSociety() so admin overrides show up immediately. */
  try {
    const soc = await getSociety();
    /* Both the header wordmark and the footer branded-meta carry the
     * `data-brand-society` attribute — hydrate ALL matches, not just
     * the first, so a `short_name` override reflects in both spots. */
    const subs = document.querySelectorAll('[data-brand-society]');
    if (subs.length && soc && soc.short_name) {
      const where = (soc.location || '').split(',')[0].trim();
      const text = where ? `${soc.short_name} · ${where}` : soc.short_name;
      subs.forEach(n => { n.textContent = text; });
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

    /* Desktop footer visibility is configurable from Settings. Each
     * section has an explicit id so admins can tune which affordances
     * appear without editing HTML. Mobile compact footer keeps its own
     * behavior and is not forced by these desktop toggles. */
    await applyFooterDesktopVisibility();
  } catch (_e) { /* keep shipped fallback */ }
});

