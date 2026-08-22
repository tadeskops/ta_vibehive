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
  /* Site-bug reports: view is gated on `reports.view` (same as audit
   * log — committee / manager / mgmt / admin) and export is gated on
   * `reports.export` (admin / mgmt only, matching Reports view). */
  const canBugView      = await can(user, 'reports.view');
  const canBugExport    = await can(user, 'reports.export');

  const tab = match.tab || 'features';
  const nav = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:16px' },
    tabLink('features', 'Feature registry', tab),
    tabLink('roles', 'Roles & permissions', tab),
    tabLink('users', 'Users', tab),
    tabLink('settings', 'Society settings', tab),
    tabLink('audit', 'Audit log', tab),
    canBugView ? tabLink('bug-reports', 'Bug reports', tab) : null,
  );

  let body;
  if (tab === 'features' && canEditFeatures) body = await renderFeatures(user);
  else if (tab === 'roles')                  body = await renderRoles();
  else if (tab === 'users' && canUsers)      body = renderUsers();
  else if (tab === 'settings' && canSettings)body = await renderSettings(user);
  else if (tab === 'audit' && canAudit)      body = renderAudit();
  else if (tab === 'bug-reports' && canBugView) body = renderBugReports({ canExport: canBugExport, user });
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
        el('td', {},
          el('span', { text: u.name || '—' }),
          u.is_verified_resident ? el('span', { class: 'pill pill-sage', style: 'margin-left:8px', text: '🛡 Verified' }) : null,
          /* Lab identity is baked into the code and cannot be demoted
           * from this list. Show a small lock pill so admins understand
           * why. */
          u.locked ? el('span', { class: 'pill', style: 'margin-left:8px;background:var(--gold);color:#fff', text: '🔒 Lab' }) : null
        ),
        el('td', { text: u.email }),
        el('td', { text: u.flat }),
        el('td', {}, el('span', { class: 'role-badge ' + roleBadgeCls(u.role), text: u.role }))
      )))
    ),
    el('p', { class: 'sub', style: 'margin-top:10px', text: 'Users are auto-provisioned on their first Google sign-in as role="resident". Promote them from here. Rows marked 🔒 Lab are baked into the code as bootstrap admins and cannot be demoted or deleted (see assets/js/lab-admin.js).' })
  );
}
function roleBadgeCls(r) { return ({ admin: '', secretary: 'sec', mgmt: 'mc', committee: 'cmt', manager: 'mgr', resident: 'res' })[r] || ''; }

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

/* ---------- site-bug reports ---------- *
 * Reports are written by `assets/js/footer.js` on every Send-attempt
 * from the "Report site bug" modal. Storage: `tvh:v1:bug_reports`.
 * View permission: `reports.view`. Export permission: `reports.export`.
 * Clearing all reports is admin-only in practice — it is a destructive
 * action, so we surface a confirm() before wiping. */
function renderBugReports({ canExport, user }) {
  const list = state.bugReports().slice();
  /* Newest first — footer.js already unshifts, but re-sort defensively
   * so hand-edited storage doesn't render out of order. */
  list.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }
  function pageLabel(p) {
    try {
      const u = new URL(p);
      return (u.hash || u.pathname || '/').slice(0, 40) || '/';
    } catch (_e) { return truncate(p, 40); }
  }
  function submitterLabel(s) {
    if (!s) return el('em', { class: 'sub', text: 'anonymous' });
    return el('span', { title: (s.email || '') + ' · ' + (s.role || '?') },
      s.name || s.email || s.id || '\u2014');
  }

  function downloadText(filename, mime, text) {
    try {
      const blob = new Blob([text], { type: mime + ';charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
    } catch (_e) { toast('Download failed.', 'err'); }
  }
  function toCsv(rows) {
    /* Minimal RFC 4180 CSV — wrap every field, escape internal quotes.
     * Newlines inside descriptions are preserved so a reviewer can
     * paste the CSV into Excel/Sheets and see the full text. */
    const header = ['id', 'ts', 'submitter_name', 'submitter_email', 'submitter_role',
      'page', 'user_agent', 'viewport', 'build', 'title', 'description',
      'screenshot_count', 'gh_url'];
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [header.map(esc).join(',')];
    rows.forEach(r => {
      const s = r.submitter || {};
      lines.push([
        r.id, r.ts, s.name, s.email, s.role,
        r.page, r.user_agent, r.viewport, r.build,
        r.title, r.description, r.screenshot_count, r.gh_url
      ].map(esc).join(','));
    });
    return lines.join('\r\n');
  }

  const actions = el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-bottom:12px' });
  if (canExport && list.length) {
    const jsonBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '⬇ Export JSON');
    jsonBtn.addEventListener('click', () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadText('vibehive-bug-reports-' + stamp + '.json', 'application/json',
        JSON.stringify(list, null, 2));
      toast('Exported ' + list.length + ' report(s) as JSON.', 'ok');
    });
    const csvBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, '⬇ Export CSV');
    csvBtn.addEventListener('click', () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadText('vibehive-bug-reports-' + stamp + '.csv', 'text/csv', toCsv(list));
      toast('Exported ' + list.length + ' report(s) as CSV.', 'ok');
    });
    actions.append(jsonBtn, csvBtn);
  }
  /* Clear-all is admin-only (matches the "destructive" bar we set for
   * every other reset action in the app). Committee/mgr can view + a
   * mgmt user can export, but only admin can wipe. */
  if (user && user.role === 'admin' && list.length) {
    const wipe = el('button', { class: 'btn btn-sm', type: 'button',
      style: 'background:var(--emerg);color:#faf3ea' }, 'Clear all');
    wipe.addEventListener('click', () => {
      if (!confirm('Delete all ' + list.length + ' locally-stored bug reports? This cannot be undone. Reports already filed on GitHub are unaffected.')) return;
      state.clearBugReports();
      toast('All bug reports cleared.', 'ok');
      /* Re-mount the tab by triggering a hashchange to the same route. */
      const cur = location.hash;
      location.hash = '#/admin';
      setTimeout(() => { location.hash = cur; }, 20);
    });
    actions.append(wipe);
  }

  const summary = el('p', { class: 'sub', style: 'margin:0 0 12px' },
    list.length
      ? String(list.length) + ' report(s) captured locally. Each Send-attempt from the "Report site bug" modal is logged here — including the ones where the reporter closed the GitHub tab before submitting. Screenshots are NOT stored (kept as filenames only) to stay within LocalStorage quotas.'
      : 'No bug reports yet. When a resident opens the "Report site bug" modal from the footer and hits Send, an entry will appear here.'
  );

  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'When' }),
      el('th', { text: 'Submitter' }),
      el('th', { text: 'Page' }),
      el('th', { text: 'Description' }),
      el('th', { text: '📎' }),
      el('th', { text: 'GitHub' })
    )),
    el('tbody', {},
      ...(list.length ? list.map(r => el('tr', {},
        el('td', { text: fmtDate(r.ts) + ' · ' + new Date(r.ts).toLocaleTimeString('en-IN', { hour12: false }) }),
        el('td', {}, submitterLabel(r.submitter)),
        el('td', {}, el('code', { class: 'mono', text: pageLabel(r.page), title: r.page })),
        el('td', { style: 'max-width:340px;white-space:pre-wrap', text: truncate(r.description, 240) }),
        el('td', { style: 'text-align:center', text: r.screenshot_count ? String(r.screenshot_count) : '' }),
        el('td', {}, r.gh_url
          ? el('a', { href: r.gh_url, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-sm btn-ghost', text: 'Open' })
          : null)
      )) : [el('tr', {}, el('td', { colspan: 6, text: 'No entries.', style: 'text-align:center;color:var(--muted)' }))])
    )
  );

  return el('div', { class: 'panel' },
    el('h3', { text: 'Site-bug reports · newest first' }),
    summary,
    actions,
    table
  );
}

/* ---------- society settings ---------- */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/* Read the current draft-cache-merged effective value at a dotted path. */
function pick(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setAt(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = val;
}
function pruneEmpty(o) {
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) {
      pruneEmpty(o[k]);
      if (!Object.keys(o[k]).length) delete o[k];
    } else if (o[k] === '' || o[k] == null) {
      delete o[k];
    }
  }
  return o;
}

async function renderSettings(user) {
  const shipped = await cfg.society();
  const overrides = state.societyOverrides();
  const effective = await getSociety();
  /* Draft-cache overlay: every keystroke writes here so a half-typed
   * archive_repo doesn't leak into live overrides, and the "Save all"
   * button flushes draft → overrides + (later) private-repo commit
   * in ONE cycle. */
  let draft = structuredClone(state.settingsDraft() || {});
  const container = el('div', {});

  const paths = [
    ['receipts.archive_repo',    'Archive repo',        'owner/private-repo'],
    ['receipts.watermark_asset', 'Watermark asset',     'assets/images/TaStampBlueOverlay.png'],
    ['receipts.stamp_asset',     'Stamp asset',         'assets/images/TaStampBlue.png'],
    ['contact.chairman',         'Chairman email',      'chairman@example.org'],
    ['contact.manager',          'Manager email',       'manager@example.org'],
    /* Payment channels used by the Contribute page. When any of these
     * are set, residents see them on the "How to pay" panel and (for
     * UPI) get a deep-link into their UPI app. See views/contribute.js. */
    ['payment.upi_vpa',          'UPI VPA',             'society@bankupi'],
    ['payment.upi_name',         'UPI payee name',      'The Address CHS Ltd'],
    ['payment.bank.holder',      'Bank a/c holder',     'The Address CHS Ltd'],
    ['payment.bank.account',     'Bank account no.',    '123456789012'],
    ['payment.bank.ifsc',        'Bank IFSC',           'SBIN0001234'],
    ['payment.bank.branch',      'Bank branch',         'Baner, Pune'],
  ];

  const inputs = {};
  for (const [p, label, ph] of paths) {
    const draftVal = pick(draft, p);
    const shownVal = draftVal != null ? draftVal : (pick(effective, p) || '');
    const inp = textInput(shownVal, ph);
    inp.addEventListener('input', () => {
      const v = inp.value.trim();
      if (v) setAt(draft, p, v);
      else {
        const parts = p.split('.');
        const parent = parts.slice(0, -1).reduce((o, k) => (o && o[k]), draft);
        if (parent) delete parent[parts[parts.length - 1]];
      }
      pruneEmpty(draft);
      state.saveSettingsDraft(draft);
      refreshMeta();
    });
    inputs[p] = { input: inp, label, path: p };
  }

  const dirtyPill = el('span', { class: 'pill pill-muted', text: '' });
  const draftCount = el('span', { class: 'pill pill-gold', text: '' });
  const outboxCount = el('span', { class: 'pill pill-sage', text: '' });

  function refreshMeta() {
    const draftKeys = flatKeys(draft);
    const overKeys  = flatKeys(overrides);
    dirtyPill.textContent = overKeys.length ? `${overKeys.length} override${overKeys.length === 1 ? '' : 's'} live` : 'shipped defaults';
    dirtyPill.className   = 'pill ' + (overKeys.length ? 'pill-gold' : 'pill-muted');
    draftCount.textContent = draftKeys.length ? `${draftKeys.length} unsaved` : 'no unsaved edits';
    draftCount.className   = 'pill ' + (draftKeys.length ? 'pill-gold' : 'pill-muted');
    const q = state.outboxSize();
    outboxCount.textContent = q ? `Archive queue · ${q}` : 'Archive queue · empty';
    outboxCount.className   = 'pill ' + (q ? 'pill-sage' : 'pill-muted');
  }

  const saveBtn = el('button', { class: 'btn', on: { click: () => {
    if (draft.receipts && draft.receipts.archive_repo && !REPO_RE.test(draft.receipts.archive_repo)) {
      toast('Archive repo must be owner/name', 'err'); return;
    }
    /* Merge draft on top of current overrides so partial edits accumulate. */
    const next = mergeDeep(structuredClone(overrides || {}), draft);
    pruneEmpty(next);
    state.saveSocietyOverrides(next);
    state.clearSettingsDraft();
    draft = {};
    state.audit({ actor: user.id, action: 'society.settings.save', detail: flatKeys(next).join(',') || 'cleared' });
    toast('Settings saved · one atomic write', 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } } }, 'Save all');

  const discardBtn = el('button', { class: 'btn btn-ghost', on: { click: () => {
    if (!flatKeys(draft).length) { toast('No draft to discard'); return; }
    state.clearSettingsDraft();
    toast('Draft discarded', 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } } }, 'Discard draft');

  const resetBtn = el('button', { class: 'btn btn-ghost', on: { click: () => {
    if (!Object.keys(overrides).length) { toast('Nothing to reset'); return; }
    state.saveSocietyOverrides({});
    state.audit({ actor: user.id, action: 'society.settings.reset' });
    toast('Overrides cleared', 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } } }, 'Reset to shipped defaults');

  /* Outbox: batched receipt-archive queue. Flushing today just clears
   * the queue and marks receipts archived locally — the real GitHub
   * Trees + Commits push lands in the private-repo slice. This UI
   * ships so residents/committee see the pending count and the
   * transactional pattern is visible from day one. */
  const flushBtn = el('button', { class: 'btn btn-sage', on: { click: async () => {
    const q = state.outbox();
    if (!q.length) { toast('Nothing to flush'); return; }
    const drained = state.drainOutbox();
    const list = state.contribs();
    for (const entry of drained) {
      const rec = list.find(c => c.receipt && c.receipt.id === entry.receiptId);
      if (rec) rec.receipt.archived = true;
    }
    state.saveContribs(list);
    state.audit({ actor: user.id, action: 'archive.flush', detail: `${drained.length} entries` });
    toast(`Flushed ${drained.length} receipt${drained.length === 1 ? '' : 's'} · one commit (offline stub)`, 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } } }, 'Flush archive queue');

  refreshMeta();

  return mount(container,
    el('div', { class: 'panel' },
      el('h3', { text: 'Society identity (read-only)' }),
      kv('Legal name', shipped.legal_name),
      kv('English name', shipped.english_name),
      kv('Registration', shipped.reg_no + ' · ' + fmtDate(shipped.reg_date)),
      kv('Location', shipped.location),
      kv('Total flats', String(shipped.total_flats)),
      el('p', { class: 'sub', style: 'margin-top:8px', text: 'Identity fields ship in config/society.json. Changes there are git-tracked so the change record is auditable.' })
    ),
    el('div', { class: 'panel' },
      el('h3', { text: 'Receipts archive · Admin only' }),
      el('p', { class: 'sub', text: 'Where verified receipts get pushed for long-term storage. Must be a private GitHub repo owned by the society. Format: owner/name.' }),
      labeledField(inputs['receipts.archive_repo'].label, inputs['receipts.archive_repo'].input, `Effective: ${effective.receipts && effective.receipts.archive_repo || '(not set)'} · ${overrides.receipts && overrides.receipts.archive_repo ? 'overridden by admin' : 'from shipped defaults'}`),
      labeledField(inputs['receipts.watermark_asset'].label, inputs['receipts.watermark_asset'].input, 'Rendered behind receipt text.'),
      labeledField(inputs['receipts.stamp_asset'].label,     inputs['receipts.stamp_asset'].input,     'Corner stamp on the receipt.'),
    ),
    el('div', { class: 'panel' },
      el('h3', { text: 'Contact addresses' }),
      labeledField(inputs['contact.chairman'].label, inputs['contact.chairman'].input, 'Used on receipts and notifications.'),
      labeledField(inputs['contact.manager'].label,  inputs['contact.manager'].input,  'On-site manager reply-to.'),
    ),
    el('div', { class: 'panel' },
      el('h3', { text: 'Draft & archive queue' }),
      el('p', { class: 'sub', text: 'Every keystroke above is cached as a draft. "Save all" writes overrides + audit in one atomic step. Verified receipts are enqueued to the archive queue and pushed together as ONE commit when you flush.' }),
      el('div', { class: 'row', style: 'gap:8px;margin-top:6px' }, draftCount, dirtyPill, outboxCount)
    ),
    el('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' },
      saveBtn, discardBtn, flushBtn, resetBtn
    )
  );
}

function flatKeys(obj, prefix = '') {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatKeys(v, p));
    else if (v != null && v !== '') out.push(p);
  }
  return out;
}
function mergeDeep(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = mergeDeep(target[k] && typeof target[k] === 'object' ? { ...target[k] } : {}, v);
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
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
