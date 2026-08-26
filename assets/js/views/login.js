/* Login view.
 * Preferred: Google Identity Services (GIS) — one-tap prompt or the
 *   rendered Google button. Consumes the shared window.Auth shim
 *   loaded by index.html (assets/js/auth-gis.js).
 * Fallback: demo persona picker — automatic on localhost ONLY. Not
 *   reachable from a live deploy (no `?demo=1` override) so residents
 *   cannot impersonate committee/admin roles on the public site. */
'use strict';
import { el, mount, toast } from '../dom.js';
import { state } from '../store.js';
import { loginAs, logout, session } from '../auth.js';

/* Inline stroke-icon SVGs — visual equivalents of ta-society-helpdesk's
 * FontAwesome fa-right-to-bracket (sign-in) and fa-right-from-bracket
 * (sign-out). Same stroke weight as the header download / bell icons
 * (assets/js/app.js) so the whole app reads as one icon family. */
const ICON_SIGNIN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="18" height="18">' +
    '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>' +
    '<polyline points="10 17 15 12 10 7"/>' +
    '<line x1="15" x2="3" y1="12" y2="12"/>' +
  '</svg>';
const ICON_SIGNOUT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="18" height="18">' +
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
    '<polyline points="16 17 21 12 16 7"/>' +
    '<line x1="21" x2="9" y1="12" y2="12"/>' +
  '</svg>';
const SVG_NS = 'http://www.w3.org/2000/svg';

function buildAuthIcon(kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');

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
  add('path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' });
  add('polyline', { points: '16 17 21 12 16 7' });
  add('line', { x1: '21', x2: '9', y1: '12', y2: '12' });
  return svg;
}

function iconSpan(svg) {
  const s = document.createElement('span');
  s.className = 'oauth-glyph';
  s.setAttribute('aria-hidden', 'true');
  s.append(buildAuthIcon(svg === ICON_SIGNIN ? 'signin' : 'signout'));
  return s;
}

/* Resolve the post-sign-in destination. Prefers the query param, then
 * falls back to a sessionStorage-persisted value (survives the mobile
 * GIS redirect path). Guarantees we never bounce back into #/login,
 * which would loop the user. Consumes the stashed value so a later
 * sign-out+sign-in doesn't send the resident to a stale destination. */
function resolveNext(next) {
  let target = next || '#/';
  try {
    if (target === '#/' && typeof sessionStorage !== 'undefined') {
      const stashed = sessionStorage.getItem('tvh:v1:login_next');
      if (stashed) target = stashed;
    }
  } catch (_e) { /* ignore */ }
  try { sessionStorage.removeItem('tvh:v1:login_next'); } catch (_e) { /* ignore */ }
  try {
    const decoded = decodeURIComponent(target);
    if (/^#\/login/.test(decoded)) return '#/';
    return decoded || '#/';
  } catch (_e) {
    return '#/';
  }
}

export async function render(root, { params }) {
  const next = params.get('next') || '#/';
  const current = session();
  const clientId = (typeof window !== 'undefined' && window.TVH_GOOGLE_CLIENT_ID) || '';
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const gisReady = !!(clientId && window.Auth && typeof window.Auth.signIn === 'function');
  /* Persist `next` to sessionStorage so it survives a mobile redirect
   * flow (some GIS paths bounce to accounts.google.com and back). */
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('tvh:v1:login_next', next);
    }
  } catch (_e) { /* private mode */ }
  /* Demo persona picker is a dev-only ergonomic shortcut. It is NEVER
   * available on a live deploy — the `?demo=1` bypass would let a
   * public visitor impersonate committee / admin roles. Gated strictly
   * on `location.hostname` matching localhost / 127.0.0.1 / [::1]. */
  const showDemo = isLocal;

  const parts = [];

  parts.push(el('h2', { text: current ? `Signed in as ${current.name}` : 'Sign in' }));
  if (current) {
    parts.push(el('p', { class: 'sub', text: 'You are already signed in. Sign out below to switch accounts.' }));
    parts.push(el('div', { class: 'row', style: 'margin-bottom:14px' },
      el('span', { class: 'pill', text: current.role }),
      el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => { logout(); toast('Signed out'); location.hash = '#/'; } } },
        iconSpan(ICON_SIGNOUT), el('span', { text: 'Sign out' }))
    ));
  } else {
    parts.push(el('p', { class: 'sub', text: 'One tap if you are already signed in with Google in this browser. Otherwise Google will prompt you, then hand you back to VibeHive.' }));
  }

  if (gisReady) {
    /* Native Google-managed sign-in button = primary CTA on ALL viewports.
     * Rationale: the previous styled "Continue with Google" fallback drove
     * a synthetic click on a fixed off-screen rendered button, which
     * Chrome / Safari popup blockers routinely kill (real gesture is
     * required for a popup). Result: users saw a red "Sign-in was
     * cancelled" toast for a flow they never really triggered.
     * The native Google button is a real anchor with a real gesture,
     * never blocked, and Google styles it consistently across browsers. */
    const nativeBtnHost = el('div', {
      class: 'tvh-gis-native',
      style: 'display:flex;justify-content:center;margin-top:14px;min-height:44px'
    });
    parts.push(nativeBtnHost);
    /* Fallback shown only if the native button fails to render after
     * retries (GIS script blocked by an ad/privacy extension). */
    const fallbackHost = el('div', {
      class: 'callout muted',
      style: 'margin-top:12px;display:none'
    },
      el('div', { style: 'flex:1' },
        el('div', { class: 'lbl', text: 'Can’t see the Google button?' }),
        el('small', { class: 'sub', text: 'A privacy extension or ad blocker may be blocking Google’s sign-in script. Disable it for this site and reload.' })
      )
    );
    parts.push(fallbackHost);
    /* Retry until GIS script has loaded + the button rendered.
     * ~4 seconds total budget (25 × 160 ms). If we still can't render,
     * surface the fallback message instead of leaving a blank card. */
    (function tryRender(attempt) {
      if (window.Auth && typeof window.Auth.renderVisibleButton === 'function') {
        const ok = window.Auth.renderVisibleButton(nativeBtnHost);
        if (ok) return;
      }
      if (attempt > 25) {
        fallbackHost.style.display = '';
        return;
      }
      setTimeout(() => tryRender(attempt + 1), 160);
    })(0);

    /* Auto-bounce: subscribe to the auth onChange event so the moment
     * the Google credential arrives (via One Tap, the visible button,
     * or a redirect return) we route to `next`. `bounced` guards against
     * a second router hop if onChange re-fires. */
    if (window.Auth && typeof window.Auth.onChange === 'function') {
      let bounced = false;
      const off = window.Auth.onChange((s) => {
        if (bounced || !s || !s.signedIn) return;
        setTimeout(() => {
          if (bounced) return;
          const cur = session();
          if (!cur) return;
          bounced = true;
          try { off(); } catch (_e) { /* ignore */ }
          toast('Signed in as ' + (cur.name || cur.email), 'ok');
          location.hash = resolveNext(next);
        }, 80);
      });
    }
    /* Tiny help line. GIS "just works" for any real Gmail address once
     * the site is on the Authorized JavaScript origin of the Google
     * OAuth client — no per-user setup, no consent-screen publish
     * drama, no redirect-URI matching. */
    parts.push(el('div', { class: 'callout muted', style: 'margin-top:14px' },
      el('div', { style: 'flex:1' },
        el('div', { class: 'lbl', text: 'How this works' }),
        el('small', { class: 'sub', text: 'Any valid Google account works. VibeHive receives a signed ID token from Google, decodes the email + name locally, and creates a resident record on first sign-in. No password, no OTP.' })
      )
    ));
  } else if (!isLocal) {
    parts.push(el('div', { class: 'callout gold', style: 'margin-top:12px' },
      el('div', { style: 'flex:1' },
        el('div', { class: 'lbl', text: 'Google sign-in not configured' }),
        el('small', { text: 'Set window.TVH_GOOGLE_CLIENT_ID in assets/js/config.js, commit, push. Full guide → ' }),
        el('a', { href: 'docs/AUTH_SETUP.md', target: '_blank', rel: 'noopener', text: 'docs/AUTH_SETUP.md' })
      )
    ));
  }

  if (showDemo) {
    const users = state.users();
    parts.push(el('h3', { style: 'margin-top:24px', text: 'Demo persona picker (localhost only)' }));
    parts.push(el('p', { class: 'sub', text: 'Available only when the site is served from localhost — never on the live deploy. Handy for iterating on role-gated views without going through Google every time.' }));
    parts.push(el('div', { class: 'stack', style: 'margin-top:10px' },
      ...users.map(u => el('button', { class: 'card card-content', style: 'text-align:left;cursor:pointer;border:1.5px solid var(--line);min-height:auto',
        on: { click: () => { loginAs(u.id); toast('Signed in as ' + u.name, 'ok'); location.hash = resolveNext(next); } } },
        el('div', { class: 'row row-between' },
          el('div', {},
            el('h3', { class: 'card-title', text: u.name }),
            el('p', { class: 'card-sub', text: `${u.role} · Flat ${u.flat || '—'}` })
          ),
          el('span', { class: 'role-badge ' + ({ admin: '', mgmt: 'mc', committee: 'cmt', manager: 'mgr', resident: 'res' })[u.role], text: u.role })
        )
      ))
    ));
  }

  mount(root, el('section', { class: 'gate' }, ...parts));
}
