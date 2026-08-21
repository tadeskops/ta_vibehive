/* Login view.
 * Preferred: real OAuth (Google / Microsoft / Yahoo) via PKCE — one tap
 *   if the user is already signed in with the provider in this browser.
 * Fallback: demo persona picker — used automatically when no provider
 *   has a clientId configured, and always on localhost so contributors
 *   can iterate without an OAuth app registered. */
'use strict';
import { el, mount, toast } from '../dom.js';
import { state, cfg } from '../store.js';
import { loginAs, logout, session } from '../auth.js';
import { beginLogin, redirectUri } from '../auth-oauth.js';

export async function render(root, { params }) {
  const next = params.get('next') || '#/';
  const current = session();
  const authCfg = await cfg.auth();
  const configured = (authCfg.providers || []).filter(p => p && p.clientId);
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const showDemo = configured.length === 0 || isLocal || params.get('demo') === '1';

  const parts = [];

  parts.push(el('h2', { text: current ? `Signed in as ${current.name}` : 'Sign in' }));
  if (current) {
    parts.push(el('p', { class: 'sub', text: 'You are already signed in. Choose a provider to switch, or sign out below.' }));
    parts.push(el('div', { class: 'row', style: 'margin-bottom:14px' },
      el('span', { class: 'pill', text: current.role }),
      el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => { logout(); toast('Signed out'); location.hash = '#/'; } } }, 'Sign out')
    ));
  } else {
    parts.push(el('p', { class: 'sub', text: 'One tap if you are already signed in with your provider in this browser. Otherwise you will be prompted by them, then bounced back.' }));
  }

  if (configured.length) {
    const list = el('div', { class: 'stack', style: 'margin-top:12px' },
      ...configured.map(p => el('button', {
        class: 'btn btn-block ' + providerBtnCls(p.id),
        on: { click: async () => {
          try { await beginLogin(p); } catch (e) { toast(e && e.message || 'Sign-in failed', 'err'); }
        } }
      }, providerGlyph(p), el('span', { text: p.label })))
    );
    parts.push(list);
    parts.push(el('p', { class: 'sub', style: 'margin-top:10px;font-size:12px', text: 'Redirect URL registered with the provider: ' + redirectUri() }));
  } else {
    parts.push(el('div', { class: 'callout gold', style: 'margin-top:12px' },
      el('div', { style: 'flex:1' },
        el('div', { class: 'lbl', text: 'OAuth providers not configured yet' }),
        el('small', { text: 'Admin: paste a Google / Microsoft / Yahoo OAuth client ID into config/auth.json (or the Admin → Settings tab in the next slice) to enable real sign-in.' })
      )
    ));
  }

  if (showDemo) {
    const users = state.users();
    parts.push(el('h3', { style: 'margin-top:24px', text: 'Demo persona picker' }));
    parts.push(el('p', { class: 'sub', text: 'Used on localhost and when no OAuth provider is configured. Removed in production once client IDs are set.' }));
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

function providerBtnCls(id) {
  return ({ google: '', microsoft: 'btn-ghost', yahoo: 'btn-sage' })[id] || '';
}
function providerGlyph(p) {
  return el('span', { class: 'oauth-glyph', text: p.icon || (p.id[0] || '?').toUpperCase() });
}

