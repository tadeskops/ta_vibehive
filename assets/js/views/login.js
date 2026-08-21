/* Login view — demo (pick-a-user) tier. Same surface as production OTP tier. */
'use strict';
import { el, mount, toast } from '../dom.js';
import { state } from '../store.js';
import { loginAs, logout, session } from '../auth.js';
import { navigate, currentPath } from '../router.js';

export async function render(root, { params }) {
  const next = params.get('next') || '#/';
  const current = session();
  const users = state.users();

  const options = el('div', { class: 'grid grid-2', style: 'margin-top:14px' },
    ...users.map(u => el('button', { class: 'card card-content', style: 'text-align:left;cursor:pointer;border:1.5px solid var(--line)',
      on: { click: () => { loginAs(u.id); toast('Signed in as ' + u.name, 'ok'); location.hash = decodeURIComponent(next); } } },
      el('div', { class: 'row row-between' },
        el('div', {},
          el('h3', { class: 'card-title', text: u.name }),
          el('p', { class: 'card-sub', text: `${u.role} · Flat ${u.flat}` })
        ),
        el('span', { class: 'role-badge ' + ({ admin: '', mgmt: 'mc', committee: 'cmt', manager: 'mgr', resident: 'res' })[u.role], text: u.role })
      )
    ))
  );

  const gate = el('section', { class: 'gate' },
    el('h2', { text: current ? `Signed in as ${current.name}` : 'Sign in' }),
    el('p', { class: 'sub', text: current ? 'You can switch to any demo persona below.' : 'Demo tier · pick a persona. Production tier will use email OTP.' }),
    current ? el('div', { class: 'row', style: 'margin-bottom:8px' },
      el('span', { class: 'pill', text: current.role }),
      el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => { logout(); toast('Signed out'); location.hash = '#/'; } } }, 'Sign out')
    ) : null,
    options
  );
  mount(root, gate);
}
