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

function iconSpan(svg) {
  const s = document.createElement('span');
  s.className = 'oauth-glyph';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = svg;
  return s;
}

export async function render(root, { params }) {
  const next = params.get('next') || '#/';
  const current = session();
  const clientId = (typeof window !== 'undefined' && window.TVH_GOOGLE_CLIENT_ID) || '';
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const gisReady = !!(clientId && window.Auth && typeof window.Auth.signIn === 'function');
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
    parts.push(el('div', { class: 'stack', style: 'margin-top:12px' },
      el('button', {
        class: 'btn btn-block',
        on: { click: async () => {
          try {
            const ok = await window.Auth.signIn();
            if (!ok) { toast('Sign-in was cancelled', 'err'); return; }
            // window.Auth.onChange (bound in app.js via bindGis) upserts + sets currentUser.
            // Give the listener a tick, then bounce.
            setTimeout(() => {
              const cur = session();
              if (cur) {
                toast('Signed in as ' + (cur.name || cur.email), 'ok');
                location.hash = decodeURIComponent(next);
              } else {
                toast('Signed in but session not restored — refresh?', 'err');
              }
            }, 60);
          } catch (e) { toast(e && e.message || 'Sign-in failed', 'err'); }
        } }
      }, iconSpan(ICON_SIGNIN), el('span', { text: 'Continue with Google' }))
    ));
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
        on: { click: () => { loginAs(u.id); toast('Signed in as ' + u.name, 'ok'); location.hash = decodeURIComponent(next); } } },
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
