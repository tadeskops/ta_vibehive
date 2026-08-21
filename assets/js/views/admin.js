/* Admin console — feature registry + user management + audit log.
 * Access-gated per action.
 */
'use strict';
import { el, mount, toast, fmtDate } from '../dom.js';
import { state, cfg, getSociety } from '../store.js';
import { catalog, isSystemOn, setSystemOverride } from '../features.js';
import { session } from '../auth.js';
import { can, labelForRole, badgeClass } from '../rbac.js';

export async function render(root, { match }) {
  const user = session();
  if (!user) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Sign in required.' })));
  const canEditFeatures = await can(user, 'features.registry.edit');
  const canUsers        = await can(user, 'users.manage');
  const canAudit        = await can(user, 'reports.view');
  const canSettings     = await can(user, 'society.settings.edit');

  const tab = match.tab || 'features';
  const nav = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:16px' },
    tabLink('features', 'Feature registry', tab),
    tabLink('roles', 'Roles & permissions', tab),
    tabLink('users', 'Users', tab),
    tabLink('settings', 'Society settings', tab),
    tabLink('audit', 'Audit log', tab),
  );

  let body;
  if (tab === 'features' && canEditFeatures) body = await renderFeatures(user);
  else if (tab === 'roles')                  body = await renderRoles();
  else if (tab === 'users' && canUsers)      body = renderUsers();
  else if (tab === 'settings' && canSettings)body = await renderSettings(user);
  else if (tab === 'audit' && canAudit)      body = renderAudit();
  else body = el('div', { class: 'card card-pad' },
    el('h3', { text: 'No access' }),
    el('p', { text: 'Ask an Admin to grant you this section.' })
  );

  const head = el('div', {},
    el('h1', { text: 'Administration' }),
    el('p', { class: 'sub', text: 'Feature toggles, roles, users, settings, and audit trail. Everything is configuration, nothing is hard-coded.' })
  );
  mount(root, head, nav, body);
}

function tabLink(id, label, active) {
  const a = el('a', { class: 'btn btn-sm ' + (active === id ? '' : 'btn-ghost'), href: '#/admin/' + id }, label);
  return a;
}

async function renderFeatures(user) {
  const cat = await catalog();
  const container = el('div', {});
  for (const cluster of cat.clusters) {
    const feats = cat.features.filter(f => f.cluster === cluster.id);
    if (!feats.length) continue;
    const panel = el('div', { class: 'panel' }, el('h3', { text: cluster.label }));
    for (const f of feats) {
      const on = await isSystemOn(f.id);
      const toggle = el('button', { type: 'button', class: 'toggle' + (on ? ' on' : ''), 'aria-label': 'toggle', title: 'Toggle ' + f.label });
      if (f.scope !== 'system' && f.scope !== 'event') {}
      toggle.addEventListener('click', async () => {
        if (f.requires_role && !(await can(user, 'features.registry.edit'))) return toast('Only Admin', 'err');
        const now = toggle.classList.toggle('on');
        await setSystemOverride(f.id, now, user);
        toast(`${f.label}: ${now ? 'ON' : 'OFF'}`, 'ok');
      });
      panel.append(el('div', { class: 'feature-row' },
        el('div', {},
          el('div', { class: 'name', text: f.label }),
          el('small', { text: `id: ${f.id} · scope: ${f.scope}${(f.depends_on || []).length ? ' · needs: ' + f.depends_on.join(', ') : ''}` })
        ),
        toggle
      ));
    }
    container.append(panel);
  }
  return container;
}

async function renderRoles() {
  const rolesCfg = await cfg.roles();
  const list = el('div', {},
    el('div', { class: 'panel' },
      el('h3', { text: 'Role hierarchy' }),
      el('p', { class: 'sub', text: 'Higher rank inherits lower-rank read scope. Actions are still permission-checked.' }),
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Role' }), el('th', { text: 'Rank' }), el('th', { text: 'What they do' }))),
        el('tbody', {}, ...rolesCfg.hierarchy.map(r => el('tr', {},
          el('td', {}, el('span', { class: r.badge, text: r.label })),
          el('td', { text: String(r.rank) }),
          el('td', { text: r.description })
        )))
      )
    ),
    el('div', { class: 'panel' },
      el('h3', { text: 'Permission matrix' }),
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Permission' }),
          ...rolesCfg.hierarchy.map(r => el('th', { text: r.label }))
        )),
        el('tbody', {}, ...Object.entries(rolesCfg.permissions).map(([perm, allowed]) => el('tr', {},
          el('td', { text: perm }),
          ...rolesCfg.hierarchy.map(r => el('td', { text: allowed.includes(r.id) ? '✓' : '' }))
        )))
      )
    )
  );
  return list;
}

function renderUsers() {
  const users = state.users();
  return el('div', { class: 'panel' },
    el('h3', { text: 'Users' }),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Name' }), el('th', { text: 'Email' }), el('th', { text: 'Flat' }), el('th', { text: 'Role' }))),
      el('tbody', {}, ...users.map(u => el('tr', {},
        el('td', { text: u.name }),
        el('td', { text: u.email }),
        el('td', { text: u.flat }),
        el('td', {}, el('span', { class: 'role-badge ' + roleBadgeCls(u.role), text: u.role }))
      )))
    ),
    el('p', { class: 'sub', style: 'margin-top:10px', text: 'Seeded demo users. Real user CRUD lands with the Cloudflare Worker OTP tier — same shape, same API.' })
  );
}
function roleBadgeCls(r) { return ({ admin: '', mgmt: 'mc', committee: 'cmt', manager: 'mgr', resident: 'res' })[r] || ''; }

function renderAudit() {
  const log = state.auditLog().slice().reverse();
  return el('div', { class: 'panel' },
    el('h3', { text: 'Audit log · newest first' }),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', { text: 'When' }), el('th', { text: 'Actor' }), el('th', { text: 'Action' }), el('th', { text: 'Detail' }))),
      el('tbody', {}, ...(log.length ? log.map(e => el('tr', {},
        el('td', { text: fmtDate(e.ts) + ' · ' + new Date(e.ts).toLocaleTimeString('en-IN', { hour12: false }) }),
        el('td', { text: e.actor || '—' }),
        el('td', { text: e.action }),
        el('td', { text: [e.event, e.feature, e.value != null ? 'val=' + e.value : null, e.contrib, e.receipt, e.reason, e.detail].filter(Boolean).join(' · ') })
      )) : [el('tr', {}, el('td', { colspan: 4, text: 'No audit entries yet.', style: 'text-align:center;color:var(--muted)' }))]))
    )
  );
}

/* ---------- society settings ---------- */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function renderSettings(user) {
  const shipped = await cfg.society();
  const overrides = state.societyOverrides();
  const effective = await getSociety();

  const inputs = {
    'receipts.archive_repo':    textInput(effective.receipts && effective.receipts.archive_repo, 'owner/private-repo'),
    'receipts.watermark_asset': textInput(effective.receipts && effective.receipts.watermark_asset, 'assets/images/TaStampBlueOverlay.png'),
    'receipts.stamp_asset':     textInput(effective.receipts && effective.receipts.stamp_asset, 'assets/images/TaStampBlue.png'),
    'contact.chairman':         textInput(effective.contact && effective.contact.chairman, 'chairman@example.org'),
    'contact.manager':          textInput(effective.contact && effective.contact.manager, 'manager@example.org'),
  };

  const saveBtn = el('button', { class: 'btn', on: { click: () => {
    const next = { receipts: {}, contact: {} };
    for (const [path, input] of Object.entries(inputs)) {
      const [g, k] = path.split('.');
      const v = input.value.trim();
      if (v) next[g][k] = v;
    }
    if (next.receipts.archive_repo && !REPO_RE.test(next.receipts.archive_repo)) {
      toast('Archive repo must be owner/name', 'err');
      return;
    }
    for (const g of Object.keys(next)) if (!Object.keys(next[g]).length) delete next[g];
    state.saveSocietyOverrides(next);
    state.audit({ actor: user.id, action: 'society.settings.save', detail: Object.keys(next).join(',') || 'cleared' });
    toast('Settings saved', 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } } }, 'Save settings');

  const resetBtn = el('button', { class: 'btn btn-ghost', on: { click: () => {
    if (!Object.keys(overrides).length) { toast('Nothing to reset'); return; }
    state.saveSocietyOverrides({});
    state.audit({ actor: user.id, action: 'society.settings.reset' });
    toast('Overrides cleared', 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } } }, 'Reset to shipped defaults');

  const dirty = Object.keys(overrides).length > 0;

  return el('div', {},
    el('div', { class: 'panel' },
      el('h3', { text: 'Society identity (read-only)' }),
      kv('Legal name', shipped.legal_name),
      kv('English name', shipped.english_name),
      kv('Registration', shipped.reg_no + ' · ' + fmtDate(shipped.reg_date)),
      kv('Location', shipped.location),
      kv('Total flats', String(shipped.total_flats)),
      el('p', { class: 'sub', style: 'margin-top:8px', text: 'Identity fields ship in config/society.json. Changes are git-tracked so the change record is auditable.' })
    ),
    el('div', { class: 'panel' },
      el('h3', { text: 'Receipts archive · Admin only' }),
      el('p', { class: 'sub', text: 'Where verified receipts get pushed for long-term storage. Must be a private GitHub repo owned by the society. Format: owner/name.' }),
      labeledField('Archive repo', inputs['receipts.archive_repo'], `Effective: ${effective.receipts.archive_repo || '(not set)'} · ${overrides.receipts && overrides.receipts.archive_repo ? 'overridden by admin' : 'from shipped defaults'}`),
      labeledField('Watermark asset', inputs['receipts.watermark_asset'], 'Rendered behind receipt text.'),
      labeledField('Stamp asset',     inputs['receipts.stamp_asset'],     'Corner stamp on the receipt.'),
    ),
    el('div', { class: 'panel' },
      el('h3', { text: 'Contact addresses' }),
      labeledField('Chairman email', inputs['contact.chairman'], 'Used on receipts and notifications.'),
      labeledField('Manager email',  inputs['contact.manager'],  'On-site manager reply-to.'),
    ),
    el('div', { class: 'row', style: 'gap:10px' }, saveBtn, resetBtn,
      el('span', { class: 'pill ' + (dirty ? 'pill-gold' : 'pill-muted'), text: dirty ? 'overrides active' : 'shipped defaults' })
    )
  );
}

function textInput(value, placeholder) {
  return el('input', { type: 'text', value: value || '', placeholder: placeholder || '' });
}
function labeledField(label, input, hint) {
  return el('div', { class: 'field' },
    el('label', { text: label }),
    input,
    hint ? el('small', { text: hint }) : null
  );
}
function kv(k, v) {
  return el('div', { class: 'feature-row' },
    el('span', { class: 'name', text: k }),
    el('span', { text: v || '—' })
  );
}
