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
import { el, mount, toast, fmtDate, modal } from '../dom.js';
import { state, cfg, getSociety } from '../store.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { busy, withSavingRing } from '../busy.js';
import { queueAndMaybePushArchive, flushArchiveQueueNow, sanitizeForArchive } from '../archive-runtime.js';
import * as api from '../api.js';

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
/**
 * Fetch the current server-side overrides through the Worker and merge
 * our local `overrides` on top. Guarantees the payload we push never
 * accidentally wipes a key another admin (or the same admin on another
 * device) already committed. Replaces the older PAT-based
 * `mergeOverridesWithRemote` for every call site that owns a settings
 * save. Falls back to `overrides` unchanged when the Worker read
 * fails (anonymous / offline).
 */
async function mergeOverridesWithWorker(overrides) {
  const localClone = overrides && typeof overrides === 'object'
    ? JSON.parse(JSON.stringify(overrides))
    : {};
  try {
    const remote = await api.readSettings();
    const remoteDoc = remote && remote.overrides;
    if (!remoteDoc || typeof remoteDoc !== 'object') return localClone;
    return mergeDeep(JSON.parse(JSON.stringify(remoteDoc)), localClone);
  } catch (_e) {
    return localClone;
  }
}
function slugId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/* Render a fake preview of a path template using representative
 * sample values. Mirrors the placeholders `paths.js` supports so the
 * Settings panel matches what will actually get committed. */
function examplePath(tpl, rollup = false) {
  const d = new Date();
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const vars = {
    eventCode: 'FESTIVAL',
    eventCodeLower: 'festival',
    eventId: 'ev-example',
    receiptId: 'FESTIVAL-20260822-2327',
    id: 'FESTIVAL-20260822-2327',
    contribId: 'c-example',
    year: y, month: m, day,
    yearMonth: `${y}-${m}`,
    date: `${y}-${m}-${day}`,
    // Same stamp placeholders as `paths.archiveVars`.
    dateStamp: `${day}${m}${y}`,
    timeStamp: '143502',
    prefix: 'TA',
    slug: 'ev-example',
    flat: 'B-805',
    contributor: 'anon',
    amount: '5101',
    period: rollup ? 'monthly' : '',
    periodKey: rollup ? `${y}-${m}` : ''
  };
  const raw = String(tpl || '').replace(/\{(\w+)\}/g, (_m, k) => vars[k] != null ? String(vars[k]) : `{${k}}`);
  return raw.replace(/^\/+/, '').replace(/\.\.+/g, '.') || '(empty)';
}

async function runBusy(label, fn) {
  return busy.wrap(label, async () => {
    const out = await fn();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return out;
  });
}

function archiveErrorText(res) {
  if (!res) return 'Archive push failed.';
  if (res.friendly) return res.friendly;
  if (res.reason === 'archive_not_configured') {
    return 'Archive repo/PAT is not configured. This save is blocked to avoid local-only drift.';
  }
  if (res.reason === 'archive_disabled') {
    return 'Archive is disabled. Enable archive in settings before saving.';
  }
  if (res.reason === 'push_failed') {
    const msg = res.error && res.error.friendly ? res.error.friendly
      : (res.error && res.error.message ? ` ${res.error.message}` : '');
    return typeof msg === 'string' && msg.trim() ? msg : 'Archive push failed.';
  }
  return 'Archive push failed.';
}

/**
 * Persist a batch of settings entries through the Worker. Entries with
 * `path === 'settings/society-overrides.json'` are written via
 * `api.writeSettings`. Other paths (e.g. receipt templates) are skipped
 * for now — they remain in local cache until a follow-up slice adds a
 * dedicated Worker route. Returns { ok, bootstrapped, reason, detail }
 * so existing call sites keep working unchanged.
 */
async function pushArchiveBatchStrict(entries) {
  const overridesEntry = (entries || []).find((e) => e && e.path === 'settings/society-overrides.json');
  if (!overridesEntry) return { ok: true, skipped: true };
  let payload;
  try {
    payload = JSON.parse(String(overridesEntry.content || '{}'));
  } catch (_e) {
    payload = {};
  }
  try {
    await api.writeSettings(payload);
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? err.message : 'Worker save failed.';
    throw new Error(msg);
  }
}

const QR_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const QR_MAX_BYTES = 350 * 1024;
async function readQrDataUrl(file) {
  if (!file) throw new Error('No file selected');
  if (!QR_ALLOWED_MIME.has(file.type)) throw new Error('QR must be a PNG, JPEG, or WebP image (SVG not allowed)');
  if (/\.svg$/i.test(file.name || '')) throw new Error('SVG QR codes are not allowed');
  if (file.size > 4 * 1024 * 1024) throw new Error('QR image too large (>4 MB)');
  const raw = await new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result || ''));
    r.onerror = () => ko(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise((ok, ko) => {
    img.onload = ok;
    img.onerror = () => ko(new Error('Image decode failed'));
    img.src = raw;
  });
  const MAX_DIM = 600;
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    const url = cv.toDataURL('image/png', q);
    if (url.length * 0.75 <= QR_MAX_BYTES) return url;
  }
  const url = cv.toDataURL('image/jpeg', 0.7);
  if (url.length * 0.75 > QR_MAX_BYTES) throw new Error('QR image too large after re-encoding');
  return url;
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
  const canUsersManage = await can(user, 'users.manage');
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
  else if (tab === 'attributes' && canAttributes)body = await renderAttributes(user, canUsersManage);
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
async function renderAttributes(user, canUsersManage) {
  const soc = await getSociety();
  const overrides = state.societyOverrides() || {};
  let draft = structuredClone(state.settingsDraft() || {});
  const vm = mergeDeep(structuredClone(soc || {}), structuredClone(draft || {}));
  const templates = state.receiptTemplates() || [];
  const users = state.users() || [];
  const canThemeOverride = await can(user, 'receipts.theme.override');
  const roleCfg = await cfg.roles();
  const roleDefs = ((roleCfg && roleCfg.hierarchy) || [])
    .map(r => ({ id: String(r.id || '').trim().toLowerCase(), label: String(r.label || r.id || '').trim() }))
    .filter(r => r.id && r.label);

  function clearAtPath(obj, path) {
    const parts = path.split('.');
    const stack = [];
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!cur || typeof cur !== 'object' || !(k in cur)) return;
      stack.push([cur, k]);
      cur = cur[k];
    }
    if (!cur || typeof cur !== 'object') return;
    delete cur[parts[parts.length - 1]];
    for (let i = stack.length - 1; i >= 0; i--) {
      const [parent, key] = stack[i];
      if (parent[key] && typeof parent[key] === 'object' && !Array.isArray(parent[key]) && !Object.keys(parent[key]).length) {
        delete parent[key];
      }
    }
  }

  const unsavedPill = el('span', { class: 'pill pill-muted', text: '' });
  const livePill = el('span', { class: 'pill pill-muted', text: '' });
  function refreshDraftMeta() {
    const unsavedKeys = flatKeys(draft).length;
    const liveKeys = flatKeys(overrides).length;
    unsavedPill.textContent = unsavedKeys ? `${unsavedKeys} unsaved` : 'no unsaved edits';
    unsavedPill.className = 'pill ' + (unsavedKeys ? 'pill-gold' : 'pill-muted');
    livePill.textContent = liveKeys ? `${liveKeys} override${liveKeys === 1 ? '' : 's'} live` : 'shipped defaults';
    livePill.className = 'pill ' + (liveKeys ? 'pill-sage' : 'pill-muted');
  }

  function stageAttr(path, value, opts) {
    if (value === undefined || value === null || value === '') clearAtPath(draft, path);
    else setAt(draft, path, value);
    pruneEmpty(draft);
    state.saveSettingsDraft(draft);
    refreshDraftMeta();
    if (!opts || !opts.silent) toast('Staged', 'ok');
  }

  const panel = (title, hint, ...rows) => el('div', { class: 'panel' },
    el('h3', { text: title }),
    hint ? el('p', { class: 'sub', text: hint }) : null,
    ...rows
  );
  const collapsiblePanel = (title, hint, collapsedByDefault, ...rows) => el('details', { class: 'panel panel-collapsible', open: !collapsedByDefault },
    el('summary', { class: 'panel-summary' },
      el('span', { class: 'panel-summary-title', text: title })
    ),
    el('div', { class: 'panel-body' },
      hint ? el('p', { class: 'sub', text: hint }) : null,
      ...rows
    )
  );

  const row = (label, help, control) => el('div', { class: 'field', style: 'margin-top:14px' },
    el('label', { class: 'lbl', text: label }),
    help ? el('small', { class: 'sub', style: 'display:block;margin-bottom:6px', text: help }) : null,
    control
  );

  /* --- Branding sub-panel --- */
  const inpShort = el('input', {
    type: 'text', value: vm.short_name || '',
    on: { change: (e) => stageAttr('short_name', e.target.value.trim()) },
    placeholder: 'e.g. The Address'
  });
  const inpLoc = el('input', {
    type: 'text', value: vm.location || '',
    on: { change: (e) => stageAttr('location', e.target.value.trim()) },
    placeholder: 'e.g. Baner, Pune'
  });
  const inpIg = el('input', {
    type: 'url', value: (vm.social && vm.social.instagram) || '',
    on: { change: (e) => stageAttr('social.instagram', e.target.value.trim()) },
    placeholder: 'https://www.instagram.com/…'
  });
  /* Handle text shown alongside the Instagram link (e.g. "@theaddress_society")
   * — read/written to `social.label` so header + footer pills update. */
  const inpIgHandle = el('input', {
    type: 'text', value: (vm.social && vm.social.label) || '',
    on: { change: (e) => stageAttr('social.label', e.target.value.trim()) },
    placeholder: '@theaddress_society'
  });

  /* --- Payment sub-panel --- */
  const pay = (vm && vm.payment) || {};
  const inpVpa = el('input', {
    type: 'text', value: pay.upi_vpa || '',
    on: { change: (e) => stageAttr('payment.upi_vpa', e.target.value.trim()) },
    placeholder: 'e.g. theaddress@hdfcbank'
  });
  const inpQr = el('input', {
    type: 'text', value: pay.qr_asset_url || '',
    on: { change: (e) => stageAttr('payment.qr_asset_url', e.target.value.trim()) },
    placeholder: 'assets/images/upi-qr.png (optional)'
  });

  /* --- Archive sub-panel ---
   * Event/settings saves are repo-gated. Keep these controls visible in
   * attributes so operators can unblock the workflow without code edits. */
  const rcfg = (vm && vm.receipts) || {};
  const inpArchiveRepo = el('input', {
    type: 'text',
    value: rcfg.archive_repo || '',
    on: { input: (e) => stageAttr('receipts.archive_repo', e.target.value.trim(), { silent: true }) },
    placeholder: 'owner/repo (e.g. tadeskops/tvh_record)'
  });
  const inpArchiveFallback = el('input', {
    type: 'text',
    value: rcfg.archive_repo_fallback || '',
    on: { input: (e) => stageAttr('receipts.archive_repo_fallback', e.target.value.trim(), { silent: true }) },
    placeholder: 'owner/repo (optional fallback target)'
  });
  const inpArchiveBranch = el('input', {
    type: 'text',
    value: rcfg.archive_branch || 'main',
    on: { input: (e) => stageAttr('receipts.archive_branch', (e.target.value || 'main').trim(), { silent: true }) },
    placeholder: 'main'
  });
  const inpArchivePat = el('input', {
    type: 'password',
    value: state.archivePat() || '',
    autocomplete: 'off',
    spellcheck: 'false',
    /* PAT stays in the browser secrets bucket. Persist directly to
     * localStorage — never through the settings draft — so it is
     * never merged into the JSON we push to the archive repo. */
    on: { input: (e) => state.saveArchivePat(e.target.value.trim()) },
    placeholder: 'Fine-grained PAT with repo contents read/write'
  });
  const cbArchiveEnabled = el('input', {
    type: 'checkbox',
    checked: !!((rcfg.archive || {}).enabled),
    on: { change: (e) => stageAttr('receipts.archive.enabled', !!e.target.checked, { silent: true }) }
  });
  let qrDataUrl = (pay.qr_data_url || '').trim();
  const qrInp = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  const qrStatus = el('small', { class: 'sub',
    text: qrDataUrl
      ? `Attached society QR (inline) · ~${Math.round((qrDataUrl.length * 0.75) / 1024)} KB`
      : 'Attach QR image (PNG/JPEG/WebP). Residents will be able to view and save it on phone from contribute screen.'
  });
  const qrPreview = el('img', {
    src: qrDataUrl,
    alt: 'Society UPI QR preview',
    style: 'display:' + (qrDataUrl ? 'block' : 'none') + ';max-width:180px;margin:8px 0;border:1px solid var(--line);border-radius:8px;background:#fff;padding:6px'
  });
  qrInp.addEventListener('change', async () => {
    const f = qrInp.files && qrInp.files[0];
    if (!f) return;
    try {
      const next = await readQrDataUrl(f);
      qrDataUrl = next;
      qrPreview.src = next;
      qrPreview.style.display = 'block';
      qrStatus.textContent = `Attached ${f.name} · ~${Math.round((next.length * 0.75) / 1024)} KB (re-encoded)`;
      stageAttr('payment.qr_data_url', next, { silent: true });
      toast('QR staged', 'ok');
    } catch (e) {
      qrInp.value = '';
      qrStatus.textContent = e.message || 'Could not attach that file.';
      toast(e.message || 'QR upload failed', 'err');
    }
  });
  const qrRemoveBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Remove attached QR');
  qrRemoveBtn.addEventListener('click', () => {
    qrDataUrl = '';
    qrInp.value = '';
    qrPreview.src = '';
    qrPreview.style.display = 'none';
    qrStatus.textContent = 'Attached QR removed. Asset path fallback (if set) will be used.';
    stageAttr('payment.qr_data_url', undefined, { silent: true });
    toast('Attached QR removal staged', 'ok');
  });
  const qrAttachWrap = el('div', {}, qrInp, qrStatus, qrPreview, el('div', { style: 'margin-top:8px' }, qrRemoveBtn));

  /* --- Receipt sub-panel — active template picker --- */
  const activeId = pick(vm, 'receipts.active_template_id') || '';
  const tplSelect = el('select', {
    on: { change: (e) => stageAttr('receipts.active_template_id', e.target.value || undefined) }
  },
    el('option', { value: '', text: '— Default (shipped template) —', selected: !activeId }),
    ...templates.map(t => el('option', { value: t.id, text: t.name || t.id, selected: t.id === activeId }))
  );
  const inpPrefix = el('input', {
    type: 'text', value: (vm.receipts && vm.receipts.prefix) || 'TA',
    maxlength: 6,
    on: { change: (e) => stageAttr('receipts.prefix', e.target.value.trim().toUpperCase().slice(0, 6)) },
    placeholder: 'TA'
  });

  /* --- Receipts archive template controls (TSH-style) ---
   * Wires perReceiptPath + rollup + language + theme so operators can
   * tune the archive layout without a code change. All values persist
   * under `receipts.archive.*` in `society-overrides.json`, which the
   * archive helpers already consume via `paths.js`. */
  const archCfg = (rcfg.archive) || {};
  const rollCfg = (archCfg.rollup) || {};
  const DEFAULT_PER_PATH    = '{eventCodeLower}/{yearMonth}/{flat}_{receiptId}_receipt.pdf';
  const DEFAULT_REPORT_PATH = 'reports/{eventCodeLower}/{prefix}_{eventCode}_{dateStamp}_{timeStamp}_report.json';
  const DEFAULT_ROLLUP_PTH = '{eventCodeLower}/bckp/{period}/{periodKey}.pdf';

  const selArchiveEnabled = el('select', {
    on: { change: (e) => stageAttr('receipts.archive.enabled', e.target.value === '1', { silent: true }) }
  },
    el('option', { value: '1', text: 'Enabled — archive every verified receipt', selected: !!archCfg.enabled }),
    el('option', { value: '0', text: 'Disabled — on-page receipts only', selected: !archCfg.enabled })
  );

  const inpArchiveTargetReadOnly = el('input', {
    type: 'text',
    value: (rcfg.archive_repo || '') + (rcfg.archive_branch ? ' · ' + rcfg.archive_branch : ' · main'),
    readOnly: true,
    style: 'background:#faf3ea;color:var(--muted);cursor:not-allowed'
  });

  const inpPerReceiptPath = el('input', {
    type: 'text',
    value: archCfg.perReceiptPath || DEFAULT_PER_PATH,
    on: { input: (e) => { stageAttr('receipts.archive.perReceiptPath', e.target.value.trim() || undefined, { silent: true }); previewPerReceiptPath.textContent = examplePath(e.target.value.trim() || DEFAULT_PER_PATH); } }
  });
  const previewPerReceiptPath = el('code', { class: 'sub', text: examplePath(archCfg.perReceiptPath || DEFAULT_PER_PATH) });

  const inpPerReportPath = el('input', {
    type: 'text',
    value: archCfg.perReportPath || DEFAULT_REPORT_PATH,
    on: { input: (e) => { stageAttr('receipts.archive.perReportPath', e.target.value.trim() || undefined, { silent: true }); previewPerReportPath.textContent = examplePath(e.target.value.trim() || DEFAULT_REPORT_PATH); } }
  });
  const previewPerReportPath = el('code', { class: 'sub', text: examplePath(archCfg.perReportPath || DEFAULT_REPORT_PATH) });

  const selRollupEnabled = el('select', {
    on: { change: (e) => stageAttr('receipts.archive.rollup.enabled', e.target.value === '1', { silent: true }) }
  },
    el('option', { value: '1', text: 'Enabled — also write a consolidated rollup', selected: rollCfg.enabled !== false }),
    el('option', { value: '0', text: 'Disabled — per-receipt files only',        selected: rollCfg.enabled === false })
  );
  const selRollupPeriod = el('select', {
    on: { change: (e) => stageAttr('receipts.archive.rollup.period', e.target.value, { silent: true }) }
  },
    el('option', { value: 'monthly',   text: 'Monthly',   selected: (rollCfg.period || 'monthly') === 'monthly' }),
    el('option', { value: 'quarterly', text: 'Quarterly', selected: rollCfg.period === 'quarterly' }),
    el('option', { value: 'yearly',    text: 'Yearly',    selected: rollCfg.period === 'yearly' })
  );
  const inpRollupPath = el('input', {
    type: 'text',
    value: rollCfg.path || DEFAULT_ROLLUP_PTH,
    on: { input: (e) => { stageAttr('receipts.archive.rollup.path', e.target.value.trim() || undefined, { silent: true }); previewRollupPath.textContent = examplePath(e.target.value.trim() || DEFAULT_ROLLUP_PTH, true); } }
  });
  const previewRollupPath = el('code', { class: 'sub', text: examplePath(rollCfg.path || DEFAULT_ROLLUP_PTH, true) });

  const selSealLang = el('select', {
    on: { change: (e) => stageAttr('receipts.seal_language', e.target.value, { silent: true }) }
  },
    el('option', { value: 'english',  text: 'English — P.O. 411045',   selected: (rcfg.seal_language || 'english') === 'english' }),
    el('option', { value: 'marathi',  text: 'Marathi — पो. 411045',    selected: rcfg.seal_language === 'marathi' }),
    el('option', { value: 'hindi',    text: 'Hindi — पो. 411045',      selected: rcfg.seal_language === 'hindi' })
  );

  const selTheme = el('select', {
    on: { change: (e) => stageAttr('receipts.default_theme', e.target.value, { silent: true }) }
  },
    el('option', { value: 'default',           text: 'Default — Community Warmth · A4 portrait',      selected: (rcfg.default_theme || 'default') === 'default' }),
    el('option', { value: 'cheque-classic',    text: 'Cheque Classic — blue grid · A5 landscape',      selected: rcfg.default_theme === 'cheque-classic' }),
    el('option', { value: 'certificate-brand', text: 'Certificate Brand — indigo + gold · A4 landscape', selected: rcfg.default_theme === 'certificate-brand' })
  );

  /* --- Dashboard sub-panel --- */
  const recentN = Number((vm.dashboard && vm.dashboard.recent_n != null) ? vm.dashboard.recent_n : 0);
  const selRecent = el('select', {
    on: { change: (e) => stageAttr('dashboard.recent_n', Number(e.target.value)) }
  },
    ...[0, 5, 10, 20, 40].map(n => el('option', { value: n, text: n === 0 ? 'All rows' : n + ' rows', selected: n === recentN }))
  );

  /* --- Event flow sub-panel — approval toggle --- */
  const requireApproval = !!(vm.events && vm.events.require_approval);
  const cbApproval = el('input', {
    type: 'checkbox', checked: requireApproval,
    on: { change: (e) => stageAttr('events.require_approval', e.target.checked ? true : undefined) }
  });

  /* --- Contribution defaults sub-panel --- */
  const defAnon = !!(vm.contributions && vm.contributions.default_anonymous);
  const cbAnon = el('input', {
    type: 'checkbox', checked: defAnon,
    on: { change: (e) => stageAttr('contributions.default_anonymous', e.target.checked ? true : undefined) }
  });
  const defHide = !!(vm.contributions && vm.contributions.default_hide_amount);
  const cbHide = el('input', {
    type: 'checkbox', checked: defHide,
    on: { change: (e) => stageAttr('contributions.default_hide_amount', e.target.checked ? true : undefined) }
  });

  /* --- Desktop footer visibility controls --- */
  const showFooterSocial = !!(((vm.footer || {}).desktop || {}).show_social);
  const showFooterBug = !!(((vm.footer || {}).desktop || {}).show_bug_report);
  const showFooterVerify = !!((vm.navigation || {}).show_verify);
  const showFooterBrandSource = !!(((vm.footer || {}).desktop || {}).show_brand_source);
  const showFooterBrandBuild = !!(((vm.footer || {}).desktop || {}).show_brand_build);
  const cbFootSocial = el('input', {
    type: 'checkbox', checked: showFooterSocial,
    on: { change: (e) => stageAttr('footer.desktop.show_social', e.target.checked ? true : undefined) }
  });
  const cbFootBug = el('input', {
    type: 'checkbox', checked: showFooterBug,
    on: { change: (e) => stageAttr('footer.desktop.show_bug_report', e.target.checked ? true : undefined) }
  });
  const cbFootVerify = el('input', {
    type: 'checkbox', checked: showFooterVerify,
    on: { change: (e) => stageAttr('navigation.show_verify', e.target.checked ? true : undefined) }
  });
  const cbFootBrandSource = el('input', {
    type: 'checkbox', checked: showFooterBrandSource,
    on: { change: (e) => stageAttr('footer.desktop.show_brand_source', e.target.checked ? true : undefined) }
  });
  const cbFootBrandBuild = el('input', {
    type: 'checkbox', checked: showFooterBrandBuild,
    on: { change: (e) => stageAttr('footer.desktop.show_brand_build', e.target.checked ? true : undefined) }
  });

  /* --- Resident email governance (gmail only for now) --- */
  const currentAllowed = (((vm.residents || {}).allowed_gmail) || []).slice();
  const allowedSet = new Set(currentAllowed.map(v => String(v || '').trim().toLowerCase()).filter(Boolean));
  const gmailOnly = (v) => /^[a-z0-9._%+-]+@gmail\.com$/i.test(String(v || '').trim());
  const canEditRoleMap = !!canUsersManage;
  const canEditAdminRoleMap = user.role === 'admin';
  const roleIds = roleDefs.map(r => r.id);
  const accessCfg = (((vm || {}).access) || {});
  const roleMap = ((accessCfg.email_roles) || {});
  const roleEmailsRaw = ((accessCfg.role_emails) || {});
  const tierRaw = ((accessCfg.role_tiers) || []);
  const roleEmailState = {};
  roleIds.forEach((id) => { roleEmailState[id] = []; });
  const addRoleEmail = (roleRaw, emailRaw) => {
    const role = String(roleRaw || '').trim().toLowerCase();
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!roleIds.includes(role) || !gmailOnly(email)) return;
    if (!roleEmailState[role].includes(email)) roleEmailState[role].push(email);
  };
  for (const [roleId, list] of Object.entries(roleEmailsRaw)) {
    if (!Array.isArray(list)) continue;
    list.forEach((email) => addRoleEmail(roleId, email));
  }
  for (const [emailRaw, roleRaw] of Object.entries(roleMap)) addRoleEmail(roleRaw, emailRaw);
  /* Compatibility hydrate for older tier payloads: flatten tiers into
   * direct role lists when present. */
  if (Array.isArray(tierRaw) && tierRaw.length) {
    tierRaw.forEach((t) => {
      const baseRole = String(t && t.base_role || '').trim().toLowerCase();
      const list = Array.isArray(t && t.emails) ? t.emails : [];
      list.forEach((email) => addRoleEmail(baseRole, email));
    });
  }
  roleIds.forEach((id) => { roleEmailState[id] = Array.from(new Set(roleEmailState[id] || [])).sort(); });
  const initialRoleEmailState = structuredClone(roleEmailState);

  const roleEditorWrap = el('div', { class: 'stack role-map-stack' });
  function renderRoleEditors() {
    roleEditorWrap.replaceChildren();
    const accordions = [];
    const roleTone = {
      admin: 'admin',
      secretary: 'sec',
      mgmt: 'mgmt',
      committee: 'cmt',
      manager: 'mgr',
      resident: 'res',
    };
    roleDefs.forEach((r) => {
      const isAdminRole = r.id === 'admin';
      const locked = !canEditRoleMap || (!canEditAdminRoleMap && isAdminRole);
      const tone = roleTone[r.id] || 'res';
      const setCountText = (countEl, list) => {
        const n = Array.isArray(list) ? list.length : 0;
        countEl.textContent = `${n} member${n === 1 ? '' : 's'}`;
      };
      const countEl = el('span', { class: 'role-map-count', text: '' });
      setCountText(countEl, roleEmailState[r.id] || []);

      const area = el('textarea', {
        rows: 3,
        placeholder: `${r.label} gmail IDs. Comma, semicolon, newline, or spaces supported.`,
        value: (roleEmailState[r.id] || []).join('\n'),
        disabled: locked,
        readOnly: locked,
      });
      area.addEventListener('input', () => {
        const next = String(area.value || '')
          .split(/[\s,;]+/)
          .map(v => String(v || '').trim().toLowerCase())
          .filter(Boolean);
        roleEmailState[r.id] = Array.from(new Set(next));
        setCountText(countEl, roleEmailState[r.id]);
      });
      const details = el('details', { class: 'panel panel-collapsible role-map-accordion' },
        el('summary', {},
          el('span', { class: 'panel-summary-title' },
            el('span', { class: `role-map-icon role-map-icon-${tone}`, 'aria-hidden': 'true' }),
            el('span', { class: 'role-map-title', text: r.label }),
            el('span', { class: 'role-map-id', text: `(${r.id})` }),
            countEl,
            locked ? el('span', { class: 'role-map-lock', text: 'Read only' }) : null
          )
        ),
        el('div', { class: 'panel-body' },
          !canEditAdminRoleMap && isAdminRole
            ? el('small', { class: 'sub', text: 'Admin role list is locked for your role.' })
            : null,
          el('div', { class: 'field', style: 'margin-top:0' },
            el('label', { class: 'lbl', text: 'Email IDs' }),
            area
          )
        )
      );
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        accordions.forEach((node) => { if (node !== details) node.open = false; });
      });
      accordions.push(details);
      roleEditorWrap.append(details);
    });
    if (accordions.length) accordions[0].open = true;
  }
  renderRoleEditors();
  const taEmailBulk = el('textarea', {
    rows: 5,
    placeholder: 'Paste one or many gmail IDs. Comma, semicolon, newline, or spaces all supported.',
  });
  const allowedPreview = el('small', {
    class: 'sub',
    text: currentAllowed.length ? `${currentAllowed.length} verified resident email(s) configured.` : 'No verified resident emails configured yet.'
  });
  const btnAddBulk = el('button', { class: 'btn btn-sm', type: 'button' }, 'Parse and add');
  const btnClearAllowed = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Clear list');
  const btnSaveRoleMap = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: !canEditRoleMap }, 'Stage role mapping');
  const normalizeRoleState = (src) => {
    const out = {};
    roleIds.forEach((id) => {
      const list = Array.isArray(src && src[id]) ? src[id] : [];
      out[id] = Array.from(new Set(list
        .map(v => String(v || '').trim().toLowerCase())
        .filter(Boolean)
      )).sort();
    });
    return out;
  };
  const roleStateDirty = () => JSON.stringify(normalizeRoleState(roleEmailState)) !== JSON.stringify(normalizeRoleState(initialRoleEmailState));

  function stageRoleMapping(opts) {
    const emitToast = !opts || opts.emitToast !== false;
    if (!canEditRoleMap) {
      if (emitToast) toast('Only Admin, Secretary, and Management Committee can edit role mappings.', 'warn');
      return { staged: false, total: 0, invalid: 0, duplicate: 0 };
    }
    const nextRoleEmails = {};
    roleIds.forEach((id) => { nextRoleEmails[id] = []; });
    const nextEmailRoles = {};
    const seen = new Set();
    let invalid = 0;
    let duplicate = 0;

    for (const roleId of roleIds) {
      const lockedAdminRole = (!canEditAdminRoleMap && roleId === 'admin');
      const sourceEmails = lockedAdminRole
        ? (initialRoleEmailState[roleId] || [])
        : (Array.isArray(roleEmailState[roleId]) ? roleEmailState[roleId] : []);
      const cleanedEmails = [];
      for (const tokenRaw of sourceEmails) {
        const token = String(tokenRaw || '').trim().toLowerCase();
        if (!token) continue;
        if (!gmailOnly(token)) { invalid += 1; continue; }
        if (seen.has(token)) { duplicate += 1; continue; }
        seen.add(token);
        cleanedEmails.push(token);
      }
      cleanedEmails.sort();
      if (cleanedEmails.length) nextRoleEmails[roleId] = cleanedEmails;
      cleanedEmails.forEach((email) => { nextEmailRoles[email] = roleId; });
    }

    stageAttr('access.role_tiers', undefined, { silent: true });
    stageAttr('access.role_emails', Object.keys(nextRoleEmails).length ? nextRoleEmails : undefined, { silent: true });
    stageAttr('access.email_roles', Object.keys(nextEmailRoles).length ? nextEmailRoles : undefined, { silent: true });

    const total = Object.keys(nextEmailRoles).length;
    if (emitToast) toast(`Staged ${total} mapped email ID(s)${invalid ? `, skipped ${invalid} invalid` : ''}${duplicate ? `, skipped ${duplicate} duplicate` : ''}. Click Save all settings changes.`, total ? 'ok' : 'warn');
    return { staged: true, total, invalid, duplicate };
  }
  btnSaveRoleMap.addEventListener('click', () => {
    stageRoleMapping({ emitToast: true });
  });
  btnAddBulk.addEventListener('click', () => {
    const raw = String(taEmailBulk.value || '');
    const tokens = raw.split(/[\s,;]+/).map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
    if (!tokens.length) {
      toast('Paste at least one email first.', 'warn');
      return;
    }
    let good = 0;
    let bad = 0;
    for (const t of tokens) {
      if (!gmailOnly(t)) { bad += 1; continue; }
      if (!allowedSet.has(t)) {
        allowedSet.add(t);
        good += 1;
      }
    }
    const next = Array.from(allowedSet).sort();
    stageAttr('residents.allowed_gmail', next.length ? next : undefined, { silent: true });
    taEmailBulk.value = '';
    allowedPreview.textContent = `${next.length} verified resident email(s) configured.`;
    toast(`Added ${good} gmail ID(s)${bad ? `, skipped ${bad} invalid/non-gmail` : ''}.`, good ? 'ok' : 'warn');
  });
  btnClearAllowed.addEventListener('click', () => {
    if (!confirm('Clear all verified resident emails?')) return;
    allowedSet.clear();
    stageAttr('residents.allowed_gmail', undefined, { silent: true });
    allowedPreview.textContent = 'No verified resident emails configured yet.';
    toast('Verified resident email list cleared.', 'ok');
  });
  const allowedTableRows = users
    .map(u => ({
      name: u.name || '—',
      email: String(u.email || ''),
      role: u.role || 'resident',
      verified: allowedSet.has(String(u.email || '').trim().toLowerCase())
    }))
    .filter(r => r.email)
    .sort((a, b) => a.email.localeCompare(b.email));

  const saveAllBtn = el('button', { class: 'btn', type: 'button' }, 'Save all settings changes');
  /* Inline processing ring shown next to the button during save so
   * the user sees local progress even when the topbar shimmer isn't
   * visible (e.g. focused on the tab body). Removed on completion. */
  const saveAllStatus = el('span', { class: 'tvh-saving-ring', 'aria-live': 'polite', hidden: true, style: 'display:none;margin-left:8px;vertical-align:middle' }, '');
  const setSaving = (on) => {
    if (on) {
      saveAllBtn.disabled = true;
      saveAllBtn.dataset.originalLabel = saveAllBtn.textContent || 'Save all settings changes';
      saveAllBtn.textContent = 'Saving…';
      saveAllStatus.hidden = false;
      saveAllStatus.style.display = 'inline-block';
    } else {
      saveAllBtn.disabled = false;
      if (saveAllBtn.dataset.originalLabel) {
        saveAllBtn.textContent = saveAllBtn.dataset.originalLabel;
      }
      saveAllStatus.hidden = true;
      saveAllStatus.style.display = 'none';
    }
  };
  saveAllBtn.addEventListener('click', async () => {
    /* Role editor uses local UI state. Auto-stage it here so users can
     * simply click Save without needing a separate Stage click first. */
    if (canEditRoleMap && roleStateDirty()) {
      stageRoleMapping({ emitToast: false });
    }
    if (!flatKeys(draft).length) {
      toast('No staged settings changes.', 'warn');
      return;
    }
    setSaving(true);
    try {
    const beforeOverrides = structuredClone(state.societyOverrides() || {});
    /* Detect archive-config changes: when present, allow bootstrap
     * save so the very first PAT / repo / enable-toggle configuration
     * persists even if the archive push cannot yet succeed. */
    const draftReceipts = (draft && draft.receipts) || {};
    const draftArchive = draftReceipts.archive || {};
    const archiveConfigTouched = Boolean(
      draftReceipts.archive_repo !== undefined ||
      draftReceipts.archive_repo_fallback !== undefined ||
      draftReceipts.archive_branch !== undefined ||
      draftArchive.enabled !== undefined ||
      /* PAT changes land in the secrets bucket (never in draft) but
       * still qualify as archive-config touches for bootstrap. */
      !!state.archivePat()
    );
    let saveResult = null;
    await runBusy('Saving settings…', async () => {
      const next = mergeDeep(structuredClone(state.societyOverrides() || {}), draft);
      pruneEmpty(next);
      state.saveSocietyOverrides(next);
      /* Pull the current remote copy and merge OUR local overrides on
       * top of it so we never overwrite keys another admin or device
       * set that we don't happen to have locally (prevents the
       * accidental role-mapping wipe seen in early tests). Then
       * sanitize to strip secrets before we serialize the payload. */
      const merged = await mergeOverridesWithWorker(next);
      const forRemote = sanitizeForArchive(merged);
      try {
        saveResult = await pushArchiveBatchStrict([
          {
            kind: 'settings',
            path: 'settings/society-overrides.json',
            content: JSON.stringify(forRemote, null, 2),
          }
        ], user.email || user.id || null, `settings: attributes save by ${user.email || user.id || 'unknown'}`, { bootstrapAllowed: archiveConfigTouched });
      } catch (err) {
        state.saveSocietyOverrides(beforeOverrides);
        throw err;
      }
      state.audit({ actor: user.email, action: 'settings.attributes.save_all', detail: flatKeys(draft).join(',') });
      state.clearSettingsDraft();
      draft = {};
      refreshDraftMeta();
    });
    if (saveResult && saveResult.bootstrapped) {
      const reason = saveResult.reason;
      const detail = saveResult.detail ? ` (${saveResult.detail})` : '';
      if (reason === 'push_failed') {
        toast(`Settings saved locally, but archive push was rejected${detail}. Fix credentials and Save again.`, 'warn');
      } else {
        toast('Settings saved locally. Archive is not yet reachable — Save again once repo/PAT are populated to commit remotely.', 'warn');
      }
    } else {
      toast('Settings saved in one consolidated write.', 'ok');
    }
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (err) {
      /* Surface the server / archive error so the user knows their
       * edit reverted and why (before this catch, a silent 403 from
       * the Worker made settings edits appear to vanish on save). */
      const msg = (err && err.message) || 'Could not save settings.';
      toast(msg, 'err');
    } finally {
      setSaving(false);
    }
  });

  const discardDraftBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Discard staged changes');
  discardDraftBtn.addEventListener('click', () => {
    if (!flatKeys(draft).length) {
      toast('No staged settings changes.', 'warn');
      return;
    }
    state.clearSettingsDraft();
    draft = {};
    refreshDraftMeta();
    toast('Staged settings draft discarded.', 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

  refreshDraftMeta();

  return el('div', {},
    panel('Society branding',
      'Public labels shown in the header, footer, and receipts.',
      row('Short name', 'Displayed in the top bar next to the bee.', inpShort),
      row('Location', 'City / neighbourhood shown alongside the short name.', inpLoc),
      row('Instagram URL', 'Powers the footer @-handle link and the mobile header shortcut.', inpIg),
      row('Instagram handle', 'Display text next to the Instagram icon (e.g. @theaddress_society).', inpIgHandle),
    ),
    panel('Payment channel',
      'Society-wide UPI details. Individual events can still override.',
      row('UPI VPA', 'Handle residents pay into (e.g. society@bank).', inpVpa),
      row('Attach UPI QR image', 'Recommended: upload once here so residents can directly view/save on phone while paying.', qrAttachWrap),
      row('UPI QR image path', 'Optional. Falls back to auto-generated QR from the VPA.', inpQr),
    ),
    panel('Receipts archive',
      'When a contribution is verified the Worker composes a PDF receipt and pushes it to the private receipts repository. Only Society Managers, Committee and Admins can view archived receipts — residents do not see them. All paths are templates; available placeholders: {eventCode} {eventCodeLower} {receiptId} {id} {year} {month} {day} {yearMonth} {flat} {period} {periodKey}.',
      row('Enabled', 'If disabled, on-page receipts still work; nothing is pushed to the private repo.', selArchiveEnabled),
      row('Target repository (from Worker env)', 'Set via GH_ARCHIVE_OWNER / GH_ARCHIVE_REPO / GH_ARCHIVE_BRANCH in wrangler.toml + TVH_ARCHIVE_PAT secret. Displayed read-only here.', inpArchiveTargetReadOnly),
      row('perReceiptPath', 'Per-receipt PDF/JSON location. End with `_receipt.<ext>` to distinguish from reports.', el('div', {}, inpPerReceiptPath,
        el('div', { style: 'margin-top:6px' }, el('small', { class: 'sub', text: 'Example preview: ' }), previewPerReceiptPath)
      )),
      row('perReportPath', 'Per-event daily report JSON location. Placeholders: {prefix} {eventCode} {dateStamp} {timeStamp}. End with `_report.json` to distinguish from receipts.', el('div', {}, inpPerReportPath,
        el('div', { style: 'margin-top:6px' }, el('small', { class: 'sub', text: 'Example preview: ' }), previewPerReportPath)
      )),
      row('rollup.enabled', 'Also write a consolidated PDF per period alongside the per-receipt files.', selRollupEnabled),
      row('rollup.period', 'Granularity of the consolidated rollup.', selRollupPeriod),
      row('rollup.path', 'Consolidated rollup location.', el('div', {}, inpRollupPath,
        el('div', { style: 'margin-top:6px' }, el('small', { class: 'sub', text: 'Example preview: ' }), previewRollupPath)
      )),
      row('Seal language (default for downloads)', 'Language used for the verified-contribution rubber stamp. Managers see only this default; residents can NOT override per download.', selSealLang),
      canThemeOverride
        ? row('Receipt theme (default for downloads)', 'Visual layout used when a resident downloads a receipt. Only Admin, Secretary and Management Committee can pick the theme; below-secretary roles inherit whatever is selected here.', selTheme)
        : null,
    ),
    panel('Receipts',
      'Active template drives what the printable receipt looks like. Manage templates in the Receipt templates tab.',
      row('Active template', 'Only one template is active at a time. Falls back to the shipped default when nothing is selected.', tplSelect),
      row('Receipt ID prefix', 'Leading token in every receipt ID (e.g. "TA-DONATION-2026-…").', inpPrefix),
    ),
    panel('Dashboard',
      'How the home screen surfaces information.',
      row('Recent contributions', 'Rows shown in the "Latest contributions" panel.', selRecent),
      row('Reset closed events', 'Removes every event with status "closed" or "archived" and every contribution + expense linked to them from local state, so the home dashboard stops counting stale sample data. Live/published events are untouched. Cannot be undone.',
        (() => {
          const btn = el('button', { class: 'btn btn-ghost', type: 'button' }, '🗑 Purge closed events');
          btn.addEventListener('click', () => {
            const evts = state.events();
            const closed = evts.filter((e) => e && (e.status === 'closed' || e.status === 'archived'));
            if (!closed.length) { toast('No closed or archived events to purge.', 'warn'); return; }
            const closedIds = new Set(closed.map((e) => e.id));
            const contribs = state.contribs() || [];
            const expenses = state.expenses() || [];
            const contribHit = contribs.filter((c) => c && closedIds.has(c.event)).length;
            const expenseHit = expenses.filter((x) => x && closedIds.has(x.event_id)).length;
            modal({
              title: 'Purge closed events?',
              body: el('div', {},
                el('p', { text: `About to remove ${closed.length} event${closed.length === 1 ? '' : 's'} (${closed.map((e) => e.title || e.id).join(', ')}).` }),
                el('p', { class: 'sub', text: `${contribHit} linked contribution${contribHit === 1 ? '' : 's'} and ${expenseHit} linked expense${expenseHit === 1 ? '' : 's'} will also be removed from local state.` }),
                el('p', { class: 'sub', style: 'margin-top:8px', text: 'Live events and their data are preserved. Cannot be undone — records that were pushed to the private archive remain in the archive repo untouched.' })
              ),
              actions: [
                { label: 'Cancel', close: true },
                { label: 'Purge', kind: 'btn', onClick: (close) => {
                  try {
                    const remainingEvents = evts.filter((e) => !closedIds.has(e.id));
                    const remainingContribs = contribs.filter((c) => !c || !closedIds.has(c.event));
                    const remainingExpenses = expenses.filter((x) => !x || !closedIds.has(x.event_id));
                    state.saveEvents(remainingEvents);
                    state.saveContribs(remainingContribs);
                    state.saveExpenses(remainingExpenses);
                    state.audit({ actor: user && user.email || null, action: 'events.purge_closed', count: closed.length, contribs: contribHit, expenses: expenseHit });
                    toast(`Purged ${closed.length} closed event${closed.length === 1 ? '' : 's'} · ${contribHit} contribution${contribHit === 1 ? '' : 's'} · ${expenseHit} expense${expenseHit === 1 ? '' : 's'}.`, 'ok');
                    close();
                    setTimeout(() => location.reload(), 250);
                  } catch (e) {
                    toast((e && e.message) || 'Purge failed', 'err');
                  }
                } },
              ],
            });
          });
          return btn;
        })()
      ),
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
    panel('Desktop footer visibility',
      'Control which footer actions and brand chips are visible. Verify receipt visibility is controlled globally (header/mobile/footer) and defaults to OFF.',
      el('label', { class: 'row', style: 'gap:8px;margin-top:14px;cursor:pointer' }, cbFootSocial, el('span', { text: 'Show society social pill' })),
      el('label', { class: 'row', style: 'gap:8px;margin-top:8px;cursor:pointer' }, cbFootBug, el('span', { text: 'Show "Report site bug" action' })),
      el('label', { class: 'row', style: 'gap:8px;margin-top:8px;cursor:pointer' }, cbFootVerify, el('span', { text: 'Show "Verify receipt" action (header/mobile/footer)' })),
      el('label', { class: 'row', style: 'gap:8px;margin-top:12px;cursor:pointer' }, cbFootBrandSource, el('span', { text: 'Show footer source link' })),
      el('label', { class: 'row', style: 'gap:8px;margin-top:8px;cursor:pointer' }, cbFootBrandBuild, el('span', { text: 'Show footer build tag (theme/version)' })),
      el('small', { class: 'sub', style: 'display:block;margin-top:6px', text: 'When both are OFF, only the society brand text (e.g. "The Address · Baner") is shown in the right meta row.' })
    ),
    collapsiblePanel('Resident access and role email mapping (gmail only)',
      'Use this list to mark verified resident emails. Event reports can optionally be restricted to this allowlist.',
      false,
      row('Bulk paste resident gmail IDs', 'Separators supported: newline, comma, semicolon, or spaces.', taEmailBulk),
      el('div', { class: 'row', style: 'gap:8px' }, btnAddBulk, btnClearAllowed),
      allowedPreview,
      row('Role to email ID mapping',
        canEditAdminRoleMap
          ? 'Direct role mapping: add one or more gmail IDs under each role. A single email can only belong to one role. Any email not mapped here is treated as Resident by default.'
          : 'Direct role mapping: you can edit non-admin roles. Admin role list is read-only for your role. Any email not mapped here is treated as Resident by default.',
        roleEditorWrap),
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, btnSaveRoleMap),
      el('div', { style: 'margin-top:10px;overflow-x:auto' },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: 'Email' }),
            el('th', { text: 'Role access' }),
            el('th', { text: 'Resident verified' })
          )),
          el('tbody', {}, ...(allowedTableRows.length
            ? allowedTableRows.map(r => el('tr', {},
              el('td', { text: r.email }),
              el('td', { text: r.role }),
              el('td', { text: r.verified ? '🛡 Green armor' : '—' })
            ))
            : [el('tr', {}, el('td', { colspan: 3, text: 'No signed-in users yet.', style: 'text-align:center;color:var(--muted)' }))]))
        )
      )
    ),
    panel('Pending settings changes',
      'Edits in this tab are staged first. Save once to publish all changes together.',
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, unsavedPill, livePill),
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:10px' }, saveAllBtn, saveAllStatus, discardDraftBtn)
    )
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
  const clone = (v) => structuredClone(v);
  /* Shipped presets — the three built-in themes we ship in
   * `views/receipt.js#buildReceiptPdf`. They appear in the templates
   * list alongside any custom template the operator has authored so
   * "Make active" flows through the same code path. Marked with
   * `shipped: true` + `theme: '<id>'` so `renderTemplates` renders
   * them read-only and the receipt page reads the theme id when
   * generating the PDF. */
  const SHIPPED_TEMPLATES = [
    {
      id: 'shipped-default',
      shipped: true,
      theme: 'default',
      name: 'Default — Community Warmth (A4 portrait)',
      header_note: '',
      thank_you_line: 'Received with thanks. This receipt is issued for records only. No goods or services have been supplied in exchange.',
      footer_note: 'Verify online at the receipt URL below.',
      show_qr: true,
      show_verify_grid: true,
      show_watermark: true,
      seal_glyph: '🐝',
      created_at: '2026-08-22T00:00:00Z',
    },
    {
      id: 'shipped-cheque-classic',
      shipped: true,
      theme: 'cheque-classic',
      name: 'Cheque Classic — blue grid (A5 landscape)',
      header_note: 'Contribution Receipt',
      thank_you_line: 'Received with thanks. This receipt is issued for records only.',
      footer_note: 'Verifiable at the online URL printed on the receipt.',
      show_qr: false,
      show_verify_grid: false,
      show_watermark: false,
      seal_glyph: '',
      created_at: '2026-08-23T00:00:00Z',
    },
    {
      id: 'shipped-certificate-brand',
      shipped: true,
      theme: 'certificate-brand',
      name: 'Certificate Brand — indigo + gold (A4 landscape)',
      header_note: 'Certificate of Contribution',
      thank_you_line: 'Presented with sincere gratitude for your generous support of the community.',
      footer_note: 'Issued by the Management Committee. Verify at the URL below.',
      show_qr: true,
      show_verify_grid: false,
      show_watermark: true,
      seal_glyph: '🏛',
      created_at: '2026-08-23T00:00:00Z',
    },
  ];
  let persistedTemplates = state.receiptTemplates() || [];
  let persistedActiveId = pick(state.societyOverrides() || {}, 'receipts.active_template_id') || '';
  let draftTemplates = clone(persistedTemplates);
  let draftActiveId = persistedActiveId;

  function hasDraftChanges() {
    return JSON.stringify(draftTemplates) !== JSON.stringify(persistedTemplates)
      || String(draftActiveId || '') !== String(persistedActiveId || '');
  }

  const wrap = el('div', {});

  function render() {
    const activeNow = draftActiveId || '';
    wrap.replaceChildren();

    const saveBtn = el('button', { class: 'btn', type: 'button' }, 'Save all template changes');
    saveBtn.addEventListener('click', async () => {
      if (!hasDraftChanges()) {
        toast('No template changes to save.', 'warn');
        return;
      }
      const beforeTemplates = structuredClone(state.receiptTemplates() || []);
      const beforeOverrides = structuredClone(state.societyOverrides() || {});
      await withSavingRing(saveBtn, async () => {
        state.saveReceiptTemplates(clone(draftTemplates));
        const o = state.societyOverrides() || {};
        setAt(o, 'receipts.active_template_id', draftActiveId || undefined);
        // Templates ride inside society-overrides.json so a single PUT /settings
        // reaches every device via sync.js (the standalone receipt-templates.json
        // path was previously silently dropped by pushArchiveBatchStrict).
        setAt(o, 'receipts.templates', clone(draftTemplates));
        pruneEmpty(o);
        state.saveSocietyOverrides(o);
        const merged = await mergeOverridesWithWorker(o);
        const forRemote = sanitizeForArchive(merged);
        try {
          await pushArchiveBatchStrict([
            {
              kind: 'settings',
              path: 'settings/society-overrides.json',
              content: JSON.stringify(forRemote, null, 2),
            }
          ], user.email || user.id || null, `settings: templates save by ${user.email || user.id || 'unknown'}`);
        } catch (err) {
          state.saveReceiptTemplates(beforeTemplates);
          state.saveSocietyOverrides(beforeOverrides);
          throw err;
        }
        state.audit({
          actor: user.email,
          action: 'settings.templates.save_all',
          detail: `templates=${draftTemplates.length};active=${draftActiveId || 'default'}`,
        });
        persistedTemplates = clone(draftTemplates);
        persistedActiveId = draftActiveId || '';
      }, { savingLabel: 'Saving templates…', busyLabel: 'Saving receipt templates…' });
      toast('Template changes saved.', 'ok');
      render();
    });

    const discardBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Discard template draft');
    discardBtn.addEventListener('click', () => {
      if (!hasDraftChanges()) {
        toast('No template draft to discard.', 'warn');
        return;
      }
      draftTemplates = clone(persistedTemplates);
      draftActiveId = persistedActiveId;
      toast('Template draft discarded.', 'ok');
      render();
    });

    const draftPill = el('span', {
      class: 'pill ' + (hasDraftChanges() ? 'pill-gold' : 'pill-muted'),
      text: hasDraftChanges() ? 'unsaved template changes' : 'no unsaved changes',
    });

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
          draftTemplates = draftTemplates.concat([t]);
          render();
          toast('Template added to draft', 'ok');
        } } }, '+ New template'),
        el('span', { class: 'sub', text: draftTemplates.length + ' template' + (draftTemplates.length === 1 ? '' : 's') }),
      ),
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:10px' }, draftPill, saveBtn, discardBtn)
    ));

    /* Combined list: shipped presets first (read-only), custom
     * drafts after. Shipped rows can be "Made active" but not edited
     * or deleted — they're built into the code path in
     * `views/receipt.js#buildReceiptPdf`. */
    const rowsToRender = [...SHIPPED_TEMPLATES, ...draftTemplates];
    if (!rowsToRender.length) {
      wrap.append(el('div', { class: 'panel' },
        el('p', { class: 'sub', style: 'margin:0', text: 'No custom templates yet. Receipts will use the shipped default layout.' })
      ));
      return;
    }

    for (const t of rowsToRender) {
      const isActive = t.id === activeNow;
      const isShipped = !!t.shipped;
      const panel = el('div', { class: 'panel' });
      const head = el('div', { class: 'row row-between', style: 'gap:8px' },
        el('div', {},
          el('h3', { text: (isShipped ? '📦 ' : '') + (t.name || t.id), style: 'margin:0' }),
          el('small', { class: 'sub', text: (isShipped ? 'shipped preset · ' : '') + 'id: ' + t.id + ' · created ' + fmtDate(t.created_at || Date.now()) }),
        ),
        el('div', { class: 'row', style: 'gap:6px' },
          isActive
            ? el('span', { class: 'pill', style: 'background:var(--sage-soft);color:var(--sage);font-weight:700', text: '✓ Active (draft)' })
            : el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => { draftActiveId = t.id; render(); toast('Template activation staged', 'ok'); } } }, 'Make active'),
          isShipped
            ? el('span', { class: 'pill pill-muted', title: 'Shipped presets cannot be edited or deleted', text: 'Read-only' })
            : el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => {
                if (!confirm('Delete template "' + (t.name || t.id) + '"?')) return;
                draftTemplates = draftTemplates.filter(x => x.id !== t.id);
                if (isActive) draftActiveId = '';
                render();
                toast('Template deletion staged', 'ok');
              } }, style: 'color:var(--terra)' }, 'Delete'),
        ),
      );
      panel.append(head);

      const upd = (patch) => {
        draftTemplates = draftTemplates.map(x => x.id === t.id ? { ...x, ...patch } : x);
        render();
      };
      /* Read-only preview for shipped presets — shows the copy but
       * hides the inputs so operators can't accidentally break the
       * theme layout. */
      if (isShipped) {
        const previewRow = (k, v) => el('div', { class: 'field', style: 'margin-top:10px' },
          el('label', { class: 'lbl', text: k }),
          el('div', { style: 'padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:#faf3ea;color:var(--muted);font-size:13px', text: v || '—' })
        );
        panel.append(
          previewRow('Header note', t.header_note),
          previewRow('Thank-you line', t.thank_you_line),
          previewRow('Footer note', t.footer_note),
          el('div', { class: 'row', style: 'gap:14px;flex-wrap:wrap;margin-top:12px' },
            el('span', { class: 'pill pill-muted', text: (t.show_qr !== false ? '✓' : '×') + ' QR' }),
            el('span', { class: 'pill pill-muted', text: (t.show_verify_grid !== false ? '✓' : '×') + ' Verify grid' }),
            el('span', { class: 'pill pill-muted', text: (t.show_watermark !== false ? '✓' : '×') + ' Watermark' }),
            el('span', { class: 'pill pill-muted', text: 'Seal ' + (t.seal_glyph || '—') }),
          )
        );
        wrap.append(panel);
        continue;
      }
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
  const soc = await getSociety();

  const disabled = !canAttributes ? { disabled: true } : {};
  let persisted = {
    residents_can_see: !!(soc.expenses && soc.expenses.residents_can_see),
    default_visible_to_residents: !!(soc.expenses && soc.expenses.default_visible_to_residents),
    categories: Array.isArray(soc.expenses && soc.expenses.categories) ? soc.expenses.categories.slice() : [],
  };
  let draft = { ...persisted, categories: persisted.categories.slice() };

  const wrap = el('div', {});
  const canEdit = canAttributes;
  const cbResidents = el('input', { type: 'checkbox', checked: draft.residents_can_see, ...disabled });
  const cbDefault = el('input', { type: 'checkbox', checked: draft.default_visible_to_residents, ...disabled });
  const inpCategories = el('textarea', {
    rows: 4,
    placeholder: 'One category per line, e.g. Mandap',
    value: draft.categories.join('\n'),
    ...disabled,
  });
  const catsHelp = el('small', { class: 'sub', style: 'display:block;margin-top:4px', text: 'One category per line. If a submitter picks "Other", they type a custom name — this list is only for the dropdown.' });
  const pill = el('span', { class: 'pill pill-muted', text: 'no unsaved changes' });

  const refreshMeta = () => {
    const dirty = draft.residents_can_see !== persisted.residents_can_see
      || draft.default_visible_to_residents !== persisted.default_visible_to_residents
      || JSON.stringify(draft.categories) !== JSON.stringify(persisted.categories);
    pill.textContent = dirty ? 'unsaved expense preference changes' : 'no unsaved changes';
    pill.className = 'pill ' + (dirty ? 'pill-gold' : 'pill-muted');
    return dirty;
  };
  cbResidents.addEventListener('change', () => {
    draft.residents_can_see = !!cbResidents.checked;
    refreshMeta();
  });
  cbDefault.addEventListener('change', () => {
    draft.default_visible_to_residents = !!cbDefault.checked;
    refreshMeta();
  });
  inpCategories.addEventListener('input', () => {
    draft.categories = String(inpCategories.value || '')
      .split(/\r?\n/)
      .map(v => v.trim())
      .filter(Boolean)
      .slice(0, 40);
    refreshMeta();
  });

  const saveBtn = el('button', { class: 'btn', type: 'button', ...(!canEdit ? { disabled: true } : {}) }, 'Save expense preferences');
  saveBtn.addEventListener('click', async () => {
    if (!canEdit) return;
    if (!refreshMeta()) {
      toast('No expense preference changes to save.', 'warn');
      return;
    }
    const beforeOverrides = structuredClone(state.societyOverrides() || {});
    await runBusy('Saving expense preferences…', async () => {
      const o = state.societyOverrides() || {};
      setAt(o, 'expenses.residents_can_see', draft.residents_can_see ? true : undefined);
      setAt(o, 'expenses.default_visible_to_residents', draft.default_visible_to_residents ? true : undefined);
      setAt(o, 'expenses.categories', draft.categories.length ? draft.categories : undefined);
      pruneEmpty(o);
      state.saveSocietyOverrides(o);
      const merged = await mergeOverridesWithWorker(o);
      const forRemote = sanitizeForArchive(merged);
      try {
        await pushArchiveBatchStrict([
          {
            kind: 'settings',
            path: 'settings/society-overrides.json',
            content: JSON.stringify(forRemote, null, 2),
          }
        ], user.email || user.id || null, `settings: expense prefs save by ${user.email || user.id || 'unknown'}`);
      } catch (err) {
        state.saveSocietyOverrides(beforeOverrides);
        throw err;
      }
      state.audit({ actor: user.email, action: 'settings.expense.save_all', detail: JSON.stringify(draft) });
      persisted = { ...draft, categories: draft.categories.slice() };
    });
    toast('Expense preferences saved.', 'ok');
    refreshMeta();
  });

  const discardBtn = el('button', { class: 'btn btn-ghost', type: 'button', ...(!canEdit ? { disabled: true } : {}) }, 'Discard expense draft');
  discardBtn.addEventListener('click', () => {
    if (!canEdit) return;
    if (!refreshMeta()) {
      toast('No expense draft to discard.', 'warn');
      return;
    }
    draft = { ...persisted, categories: persisted.categories.slice() };
    cbResidents.checked = draft.residents_can_see;
    cbDefault.checked = draft.default_visible_to_residents;
    inpCategories.value = draft.categories.join('\n');
    refreshMeta();
    toast('Expense draft discarded.', 'ok');
  });

  wrap.append(
    el('div', { class: 'panel' },
      el('h3', { text: 'Expense visibility' }),
      el('p', { class: 'sub', text: 'Committee and manager roles can record expenses against an event so residents see where their contributions are going. You can control whether residents see them at all, and the default for each new expense row.' }),
      el('label', { class: 'row', style: 'gap:8px;margin-top:14px;cursor:pointer' },
        cbResidents,
        el('span', { text: 'Allow residents to see expenses (globally)' }),
      ),
      el('label', { class: 'row', style: 'gap:8px;margin-top:8px;cursor:pointer' },
        cbDefault,
        el('span', { text: 'Default each new expense row to visible-to-residents' }),
      ),
      el('p', { class: 'sub', style: 'margin-top:12px', text: 'Each expense row can still override this per-row on the event detail page.' }),
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:10px' }, pill, saveBtn, discardBtn),
    ),
    el('div', { class: 'panel' },
      el('h3', { text: 'Expense categories' }),
      el('p', { class: 'sub', text: 'Categories shown in the Submit-expense dropdown. Any access role with settings edit can update this list. Submitters who need something else can pick "Other" and type a custom name.' }),
      el('label', { class: 'lbl', style: 'display:block;margin-top:10px', text: 'Category list' }),
      inpCategories,
      catsHelp,
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
  refreshMeta();
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
