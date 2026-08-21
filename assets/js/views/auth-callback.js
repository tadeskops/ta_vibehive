/* OAuth callback handler.
 * Reads code+state from the query string, exchanges via PKCE, upserts a
 * local user record (resident by default), sets the session, redirects
 * to the intended landing route. Shows a friendly error card on failure
 * so the user is never dropped on a blank screen.
 */
'use strict';
import { el, mount, toast } from '../dom.js';
import { cfg } from '../store.js';
import { completeLogin } from '../auth-oauth.js';
import { loginWithProfile } from '../auth.js';

export async function render(root, { params }) {
  const spinner = el('section', { class: 'gate' },
    el('h2', { text: 'Signing you in…' }),
    el('p', { class: 'sub', text: 'Finishing the handshake with your provider. This takes a moment.' })
  );
  mount(root, spinner);

  const code  = params.get('code');
  const state = params.get('state');
  const next  = params.get('next') || '#/';

  if (!code || !state) {
    return renderError(root, 'Missing code or state', 'The provider did not return a valid response. Please try again.', next);
  }

  try {
    const authCfg = await cfg.auth();
    const profile = await completeLogin(authCfg.providers, code, state);
    const user = loginWithProfile(profile);
    toast('Welcome, ' + user.name.split(' ')[0], 'ok');
    // Strip the ?code=&state= from the URL so refresh doesn't retry.
    history.replaceState({}, '', location.pathname);
    location.hash = decodeURIComponent(next);
  } catch (err) {
    renderError(root, 'Sign-in failed', err && err.message ? err.message : String(err), next);
  }
}

function renderError(root, title, msg, next) {
  const card = el('section', { class: 'gate' },
    el('h2', { text: title }),
    el('p', { text: msg }),
    el('div', { class: 'row', style: 'margin-top:12px;gap:10px' },
      el('a', { class: 'btn', href: '#/login' }, 'Back to sign in'),
      el('a', { class: 'btn btn-ghost', href: next || '#/' }, 'Home')
    )
  );
  mount(root, card);
}
