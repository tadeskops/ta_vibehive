/* Settings view — role-scoped configuration surface.
 *
 * Scope by role (roles.json → permissions):
 *   - resident            : NO ACCESS (redirected to home)
 *   - manager             : Attributes tab only
 *   - committee           : Attributes + Templates tabs
 *   - mgmt                : Attributes + Templates tabs
 *   - admin               : Attributes + Templates + Features tabs (Features
 *                           links to /admin/features for the existing detailed
 *                           toggle UI so we don't fork the truth).
 *
 * All non-admin roles can configure feature ATTRIBUTES (e.g. active
 * receipt template, dashboard defaults, event-approval toggle) — only
 * admin can turn features on/off entirely. This mirrors the user's ask:
 * "all non admin and nonresident shall be able to configure features
 * attributes while admin can enable and disable the feature".
 */
'use strict';
import { el, mount, toast, fmtDate } from '../dom.js';
import { state, cfg, getSociety } from '../store.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';

/* ---------- helpers ---------- */
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
  if (!o || typeof o !== 'object') return o;
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
function slugId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/* ---------- render entry ---------- */
export async function render(root, { match }) {
  const user = session();
  if (!user) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Sign in required' }),
      el('p', { class: 'sub', text: 'Settings are only visible to committee, management and admin roles.' }),
      el('a', { class: 'btn', href: '#/login', text: 'Sign in' })
    ));
  }
  if (user.role === 'resident') {
    /* Residents don't see settings at all — bounce to home with a toast
     * so they understand the redirect. */
    toast('Settings are restricted to committee, management and admin.', 'warn');
    location.hash = '#/';
    return;
  }
  const canSettings   = await can(user, 'settings.view');
  const canAttributes = await can(user, 'settings.attributes.edit');
  const canTemplates  = await can(user, 'settings.templates.edit');
  const canFeatures   = await can(user, 'features.registry.edit');
  const canExpenses   = await can(user, 'expenses.view');
  if (!canSettings) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h3', { text: 'No access' }),
      el('p', { text: 'Ask an Admin to grant you settings access.' })
    ));
  }

  const tab = (match && match.tab) || 'attributes';
  const tabs = [];
  if (canAttributes) tabs.push(['attributes', 'Attributes']);
  if (canTemplates)  tabs.push(['templates', 'Receipt templates']);
  if (canExpenses)   tabs.push(['expenses', 'Expense preferences']);
  if (canFeatures)   tabs.push(['features', 'Features (admin)']);

  const nav = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:16px' },
    ...tabs.map(([id, label]) => el('a', {
      class: 'btn btn-sm ' + (tab === id ? '' : 'btn-ghost'),
      href: '#/settings/' + id,
      text: label,
    }))
  );

  let body;
  if (tab === 'templates' && canTemplates)       body = await renderTemplates(user);
  else if (tab === 'expenses' && canExpenses)    body = await renderExpensePrefs(user, canAttributes);
  else if (tab === 'features' && canFeatures)    body = renderFeaturesRedirect();
  else if (tab === 'attributes' && canAttributes)body = await renderAttributes(user);
  else                                           body = el('div', { class: 'card card-pad' },
    el('h3', { text: 'No access to this tab' }),
    el('p', { class: 'sub', text: 'Pick a different tab above.' })
  );

  mount(root,
    el('div', {},
      el('h1', { text: 'Settings' }),
      el('p', { class: 'sub', text: user.role === 'admin'
        ? 'Admin scope — configure feature attributes here, or toggle features on/off from the Features tab.'
        : 'Configure the day-to-day attributes of your society here. Feature on/off toggles are Admin-only.' })
    ),
    nav,
    body
  );
}

/* ------------------------------------------------------------------
 * Tab 1 — Attributes
 * ------------------------------------------------------------------
 * The "attributes" tab is where non-admin roles configure the
 * data-shaped side of features: which receipt template is active, how
 * many rows the dashboard shows, whether new events require approval,
 * default contribution privacy, event-side expenses toggle. Admin can
 * also edit these — this is NOT a feature toggle screen, it's the
 * "parameters" screen.
 *
 * All writes go through state.societyOverrides() so the runtime
 * getSociety() merges them with shipped defaults. No draft-cache
 * (unlike admin.js) — attributes are small and low-risk, so we save
 * inline as the user changes them.  */
async function renderAttributes(user) {
  const soc = await getSociety();
  const overrides = state.societyOverrides() || {};
  const templates = state.receiptTemplates() || [];

  /* Small helper — save a single dotted-path attribute back into
   * societyOverrides. Toast is optional (spammy for range inputs). */
  function saveAttr(path, value, opts) {
    const o = state.societyOverrides() || {};
    setAt(o, path, value);
    pruneEmpty(o);
    state.saveSocietyOverrides(o);
    state.audit({ actor: user.email, action: 'settings.attribute', detail: path + '=' + JSON.stringify(value) });
    if (!opts || !opts.silent) toast('Saved', 'ok');
  }

  const panel = (title, hint, ...rows) => el('div', { class: 'panel' },
    el('h3', { text: title }),
    hint ? el('p', { class: 'sub', text: hint }) : null,
    ...rows
  );

  const row = (label, help, control) => el('div', { class: 'field', style: 'margin-top:14px' },
    el('label', { class: 'lbl', text: label }),
    help ? el('small', { class: 'sub', style: 'display:block;margin-bottom:6px', text: help }) : null,
    control
  );

  /* --- Branding sub-panel --- */
  const inpShort = el('input', {
    type: 'text', value: soc.short_name || '',
    on: { change: (e) => saveAttr('short_name', e.target.value.trim()) },
    placeholder: 'e.g. The Address'
  });
  const inpLoc = el('input', {
    type: 'text', value: soc.location || '',
    on: { change: (e) => saveAttr('location', e.target.value.trim()) },
    placeholder: 'e.g. Baner, Pune'
  });
  const inpIg = el('input', {
    type: 'url', value: (soc.social && soc.social.instagram) || '',
    on: { change: (e) => saveAttr('social.instagram', e.target.value.trim()) },
    placeholder: 'https://www.instagram.com/…'
  });

  /* --- Payment sub-panel --- */
  const inpVpa = el('input', {
    type: 'text', value: (soc.payment && soc.payment.upi_vpa) || '',
    on: { change: (e) => saveAttr('payment.upi_vpa', e.target.value.trim()) },
    placeholder: 'e.g. theaddress@hdfcbank'
  });
  const inpQr = el('input', {
    type: 'text', value: (soc.payment && soc.payment.qr_asset_url) || '',
    on: { change: (e) => saveAttr('payment.qr_asset_url', e.target.value.trim()) },
    placeholder: 'assets/images/upi-qr.png (optional)'
  });

  /* --- Receipt sub-panel — active template picker --- */
  const activeId = pick(overrides, 'receipts.active_template_id') || '';
  const tplSelect = el('select', {
    on: { change: (e) => saveAttr('receipts.active_template_id', e.target.value || undefined) }
  },
    el('option', { value: '', text: '— Default (shipped template) —', selected: !activeId }),
    ...templates.map(t => el('option', { value: t.id, text: t.name || t.id, selected: t.id === activeId }))
  );
  const inpPrefix = el('input', {
    type: 'text', value: (soc.receipts && soc.receipts.prefix) || 'TA',
    maxlength: 6,
    on: { change: (e) => saveAttr('receipts.prefix', e.target.value.trim().toUpperCase().slice(0, 6)) },
    placeholder: 'TA'
  });

  /* --- Dashboard sub-panel --- */
  const recentN = Number((soc.dashboard && soc.dashboard.recent_n) || 5);
  const selRecent = el('select', {
    on: { change: (e) => saveAttr('dashboard.recent_n', Number(e.target.value)) }
  },
    ...[5, 10, 20, 50].map(n => el('option', { value: n, text: n + ' rows', selected: n === recentN }))
  );

  /* --- Event flow sub-panel — approval toggle --- */
  const requireApproval = !!(soc.events && soc.events.require_approval);
  const cbApproval = el('input', {
    type: 'checkbox', checked: requireApproval,
    on: { change: (e) => saveAttr('events.require_approval', e.target.checked ? true : undefined) }
  });

  /* --- Contribution defaults sub-panel --- */
  const defAnon = !!(soc.contributions && soc.contributions.default_anonymous);
  const cbAnon = el('input', {
    type: 'checkbox', checked: defAnon,
    on: { change: (e) => saveAttr('contributions.default_anonymous', e.target.checked ? true : undefined) }
  });
  const defHide = !!(soc.contributions && soc.contributions.default_hide_amount);
  const cbHide = el('input', {
    type: 'checkbox', checked: defHide,
    on: { change: (e) => saveAttr('contributions.default_hide_amount', e.target.checked ? true : undefined) }
  });

  return el('div', {},
    panel('Society branding',
      'Public labels shown in the header, footer, and receipts.',
      row('Short name', 'Displayed in the top bar next to the bee.', inpShort),
      row('Location', 'City / neighbourhood shown alongside the short name.', inpLoc),
      row('Instagram URL', 'Powers the footer @-handle and the mobile header shortcut.', inpIg),
    ),
    panel('Payment channel',
      'Society-wide UPI details. Individual events can still override.',
      row('UPI VPA', 'Handle residents pay into (e.g. society@bank).', inpVpa),
      row('UPI QR image path', 'Optional. Falls back to auto-generated QR from the VPA.', inpQr),
    ),
    panel('Receipts',
      'Active template drives what the printable receipt looks like. Manage templates in the Receipt templates tab.',
      row('Active template', 'Only one template is active at a time. Falls back to the shipped default when nothing is selected.', tplSelect),
      row('Receipt ID prefix', 'Leading token in every receipt ID (e.g. "TA-DONATION-2026-…").', inpPrefix),
    ),
    panel('Dashboard',
      'How the home screen surfaces information.',
      row('Recent contributions', 'Rows shown in the "Latest contributions" panel.', selRecent),
    ),
    panel('Event flow',
      'Controls the approval gate for new event proposals.',
      el('label', { class: 'row', style: 'gap:8px;margin-top:14px;cursor:pointer' },
        cbApproval,
        el('span', { text: 'Require committee approval before an event goes live' }),
      ),
      el('small', { class: 'sub', style: 'display:block;margin-top:6px', text: 'When ON, resident/committee-proposed events land in "Pending approval" until an Admin or Management member approves them.' }),
    ),
    panel('Contribution privacy defaults',
      'Pre-selected values when a resident opens the contribute form.',
      el('label', { class: 'row', style: 'gap:8px;margin-top:14px;cursor:pointer' },
        cbAnon,
        el('span', { text: 'Default the contribution as anonymous' }),
      ),
      el('label', { class: 'row', style: 'gap:8px;margin-top:8px;cursor:pointer' },
        cbHide,
        el('span', { text: 'Default the "hide amount from public list" toggle to ON' }),
      ),
    ),
  );
}

/* ------------------------------------------------------------------
 * Tab 2 — Receipt templates
 * ------------------------------------------------------------------
 * Multiple templates can coexist. Exactly one is active at a time (set
 * from the Attributes tab). Editing here just persists to
 * state.receiptTemplates(); the receipt view reads the active one and
 * layers its header/footer/thank-you strings over the base render. */
async function renderTemplates(user) {
  let templates = state.receiptTemplates() || [];
  const overrides = state.societyOverrides() || {};
  const activeId = pick(overrides, 'receipts.active_template_id') || '';

  function persist() {
    state.saveReceiptTemplates(templates);
    state.audit({ actor: user.email, action: 'settings.templates.save', detail: 'count=' + templates.length });
  }
  function setActive(id) {
    const o = state.societyOverrides() || {};
    setAt(o, 'receipts.active_template_id', id || undefined);
    pruneEmpty(o);
    state.saveSocietyOverrides(o);
    state.audit({ actor: user.email, action: 'settings.templates.activate', detail: id || 'default' });
  }

  const wrap = el('div', {});

  function render() {
    templates = state.receiptTemplates() || [];
    const activeNow = (state.societyOverrides() || {}).receipts && (state.societyOverrides() || {}).receipts.active_template_id || '';
    wrap.replaceChildren();

    /* Intro panel */
    wrap.append(el('div', { class: 'panel' },
      el('h3', { text: 'Receipt templates' }),
      el('p', { class: 'sub', text: 'Design and save reusable receipt layouts. Any number can coexist — only the one marked "Active" is used when generating a receipt. To switch, tap "Make active" on a row.' }),
      el('div', { class: 'row', style: 'gap:8px;margin-top:8px' },
        el('button', { class: 'btn', on: { click: () => {
          const t = {
            id: slugId('tpl'),
            name: 'New template',
            header_note: '',
            thank_you_line: 'Thank you for your contribution to our community.',
            footer_note: 'This receipt is verifiable at the QR/URL below.',
            show_qr: true,
            show_verify_grid: true,
            show_watermark: true,
            seal_glyph: '🐝',
            created_at: new Date().toISOString(),
          };
          templates = (state.receiptTemplates() || []).concat([t]);
          persist();
          render();
          toast('Template added', 'ok');
        } } }, '+ New template'),
        el('span', { class: 'sub', text: templates.length + ' template' + (templates.length === 1 ? '' : 's') }),
      )
    ));

    /* Row per template */
    if (!templates.length) {
      wrap.append(el('div', { class: 'panel' },
        el('p', { class: 'sub', style: 'margin:0', text: 'No custom templates yet. Receipts will use the shipped default layout.' })
      ));
      return;
    }

    for (const t of templates) {
      const isActive = t.id === activeNow;
      const panel = el('div', { class: 'panel' });
      const head = el('div', { class: 'row row-between', style: 'gap:8px' },
        el('div', {},
          el('h3', { text: t.name || t.id, style: 'margin:0' }),
          el('small', { class: 'sub', text: 'id: ' + t.id + ' · created ' + fmtDate(t.created_at || Date.now()) }),
        ),
        el('div', { class: 'row', style: 'gap:6px' },
          isActive
            ? el('span', { class: 'pill', style: 'background:var(--sage-soft);color:var(--sage);font-weight:700', text: '✓ Active' })
            : el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => { setActive(t.id); render(); toast('Template activated', 'ok'); } } }, 'Make active'),
          el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => {
            if (!confirm('Delete template "' + (t.name || t.id) + '"?')) return;
            templates = templates.filter(x => x.id !== t.id);
            persist();
            if (isActive) setActive('');
            render();
            toast('Template deleted', 'ok');
          } }, style: 'color:var(--terra)' }, 'Delete'),
        ),
      );
      panel.append(head);

      const upd = (patch) => {
        templates = templates.map(x => x.id === t.id ? { ...x, ...patch } : x);
        persist();
      };
      panel.append(
        el('div', { class: 'field', style: 'margin-top:14px' },
          el('label', { class: 'lbl', text: 'Template name' }),
          el('input', { type: 'text', value: t.name || '', on: { change: (e) => upd({ name: e.target.value.trim() || t.id }) } }),
        ),
        el('div', { class: 'field' },
          el('label', { class: 'lbl', text: 'Header note (above the amount)' }),
          el('small', { class: 'sub', style: 'display:block;margin-bottom:6px', text: 'Short leading line — e.g. "Festival Contribution 2026". Leave blank to hide.' }),
          el('input', { type: 'text', value: t.header_note || '', on: { change: (e) => upd({ header_note: e.target.value.trim() }) }, placeholder: 'e.g. Festival Contribution 2026' }),
        ),
        el('div', { class: 'field' },
          el('label', { class: 'lbl', text: 'Thank-you line' }),
          el('input', { type: 'text', value: t.thank_you_line || '', on: { change: (e) => upd({ thank_you_line: e.target.value.trim() }) }, placeholder: 'e.g. Thank you for supporting your community.' }),
        ),
        el('div', { class: 'field' },
          el('label', { class: 'lbl', text: 'Footer note' }),
          el('input', { type: 'text', value: t.footer_note || '', on: { change: (e) => upd({ footer_note: e.target.value.trim() }) }, placeholder: 'e.g. Registered under Society Act 1960.' }),
        ),
        el('div', { class: 'row', style: 'gap:14px;flex-wrap:wrap;margin-top:14px' },
          el('label', { class: 'row', style: 'gap:6px;cursor:pointer' },
            el('input', { type: 'checkbox', checked: t.show_qr !== false, on: { change: (e) => upd({ show_qr: e.target.checked }) } }),
            el('span', { text: 'Show verify QR' })
          ),
          el('label', { class: 'row', style: 'gap:6px;cursor:pointer' },
            el('input', { type: 'checkbox', checked: t.show_verify_grid !== false, on: { change: (e) => upd({ show_verify_grid: e.target.checked }) } }),
            el('span', { text: 'Show verify grid' })
          ),
          el('label', { class: 'row', style: 'gap:6px;cursor:pointer' },
            el('input', { type: 'checkbox', checked: t.show_watermark !== false, on: { change: (e) => upd({ show_watermark: e.target.checked }) } }),
            el('span', { text: 'Show watermark' })
          ),
          el('label', { class: 'row', style: 'gap:6px' },
            el('span', { text: 'Seal glyph' }),
            el('input', { type: 'text', maxlength: 4, style: 'width:60px', value: t.seal_glyph || '🐝', on: { change: (e) => upd({ seal_glyph: (e.target.value || '🐝').slice(0, 4) }) } }),
          ),
        ),
      );
      wrap.append(panel);
    }
  }
  render();
  return wrap;
}

/* ------------------------------------------------------------------
 * Tab 3 — Expense preferences
 * ------------------------------------------------------------------
 * Society-wide expense visibility settings. Individual expense rows
 * carry a per-row `visible_to_residents` flag, but here we set the
 * default for new rows and whether residents can see any expenses at
 * all (privacy gate). Actual expense CRUD is on the event detail page
 * for committee/manager roles. */
async function renderExpensePrefs(user, canAttributes) {
  const overrides = state.societyOverrides() || {};
  const soc = await getSociety();

  function saveAttr(path, value) {
    const o = state.societyOverrides() || {};
    setAt(o, path, value);
    pruneEmpty(o);
    state.saveSocietyOverrides(o);
    state.audit({ actor: user.email, action: 'settings.expense', detail: path + '=' + JSON.stringify(value) });
    toast('Saved', 'ok');
  }

  const disabled = !canAttributes ? { disabled: true } : {};
  const residentsCanSee = !!(soc.expenses && soc.expenses.residents_can_see);
  const defaultVisible = !!(soc.expenses && soc.expenses.default_visible_to_residents);

  const wrap = el('div', {});
  wrap.append(
    el('div', { class: 'panel' },
      el('h3', { text: 'Expense visibility' }),
      el('p', { class: 'sub', text: 'Committee and manager roles can record expenses against an event so residents see where their contributions are going. You can control whether residents see them at all, and the default for each new expense row.' }),
      el('label', { class: 'row', style: 'gap:8px;margin-top:14px;cursor:pointer' },
        el('input', { type: 'checkbox', checked: residentsCanSee, ...disabled,
          on: { change: (e) => saveAttr('expenses.residents_can_see', e.target.checked ? true : undefined) } }),
        el('span', { text: 'Allow residents to see expenses (globally)' }),
      ),
      el('label', { class: 'row', style: 'gap:8px;margin-top:8px;cursor:pointer' },
        el('input', { type: 'checkbox', checked: defaultVisible, ...disabled,
          on: { change: (e) => saveAttr('expenses.default_visible_to_residents', e.target.checked ? true : undefined) } }),
        el('span', { text: 'Default each new expense row to visible-to-residents' }),
      ),
      el('p', { class: 'sub', style: 'margin-top:12px', text: 'Each expense row can still override this per-row on the event detail page.' }),
    ),
    el('div', { class: 'panel' },
      el('h3', { text: 'How expenses are recorded' }),
      el('ol', { style: 'padding-left:20px;color:var(--muted);font-size:14px' },
        el('li', { text: 'Open an event from the Events list.' }),
        el('li', { text: 'Committee / manager see an "Expenses" section with an Add button.' }),
        el('li', { text: 'Enter amount, category, note; optionally attach a receipt URL.' }),
        el('li', { text: 'Toggle "Visible to residents" per row (defaults set here).' }),
        el('li', { text: 'Expenses flow into the Reports view alongside contributions.' }),
      ),
    ),
  );
  return wrap;
}

/* ------------------------------------------------------------------
 * Tab 4 — Features (admin only)
 * ------------------------------------------------------------------
 * The dedicated feature-toggle UI already lives in admin.js so we
 * simply link there instead of forking the truth. Keeps behaviour and
 * audit trail centralised. */
function renderFeaturesRedirect() {
  return el('div', { class: 'panel' },
    el('h3', { text: 'Feature toggles' }),
    el('p', { class: 'sub', text: 'Turning individual features on/off is Admin-only. This lives in the Admin console under the "Feature registry" tab.' }),
    el('a', { class: 'btn', href: '#/admin/features', text: 'Open Feature registry →' }),
    el('p', { class: 'sub', style: 'margin-top:12px', text: 'Everything else — attributes, receipt templates, expense preferences — you can configure right here without leaving Settings.' }),
  );
}
