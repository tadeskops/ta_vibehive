/* Report builder — export contribution data as PDF / archive.
 *
 * Scopes:
 *   - all events
 *   - published events only
 *   - one or many selected events
 *   - date range (monthly, yearly, or custom day-precise)
 *
 * Access:   RBAC-gated on `reports.view`.
 * Feature:  system-scope flag `reporting.export`.
 *
 * Output:
 *   - Download PDF (jsPDF + autoTable, TSH-style).
 *   - Save snapshot to archive — enqueues a PDF to state.outbox so the
 *     next "Flush archive queue" push commits it to the private
 *     receipt-archive repo alongside the receipt JSONs. Path shape:
 *     `reports/<scope>/YYYY-MM-DDTHHMM.pdf`
 *
 * The scheduled 3×/day server-side snapshot is produced by
 *   .github/workflows/reports-cron.yml -> scripts/generate-reports.mjs
 * which walks the private repo, not the browser, so it works without
 * anyone opening the app.
 */
'use strict';
import { el, mount, clear, fmtINR, fmtDate, toast } from '../dom.js';
import { state, getSociety } from '../store.js';
import { isSystemOn, isEventOn } from '../features.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { findEvent, canViewEventDetailedReport } from '../events.js';
import { queueAndMaybePushArchive } from '../archive-runtime.js';

const LS_KEY = 'tvh:v1:reports:filters';
const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const AUTOTABLE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
const STATUSES = ['pending', 'verified', 'void'];
const DEFAULT_COLS = [
  { id: 'event',       label: 'Event',        default: true },
  { id: 'contributor', label: 'Contributor',  default: true },
  { id: 'flat',        label: 'Flat',         default: true },
  { id: 'amount',      label: 'Amount',       default: true },
  { id: 'method',      label: 'Method',       default: true },
  { id: 'status',      label: 'Status',       default: true },
  { id: 'ref',         label: 'Ref / Txn',    default: false },
  { id: 'created_at',  label: 'Created',      default: true },
  { id: 'verified_at', label: 'Verified',     default: false },
  { id: 'remarks',     label: 'Remarks',      default: false },
];

function loadFilters() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_e) { return {}; }
}
function saveFilters(f) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(f)); } catch (_e) { /* quota */ }
}

export async function render(root, { match } = {}) {
  const forcedEventId = match && match.id ? match.id : '';
  const user = session();
  if (!user) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Sign in required' }),
      el('p', { class: 'sub', text: 'Reports are visible to committee members and above.' }),
      el('a', { class: 'btn', href: '#/login' }, 'Sign in')
    ));
  }
  const allowed = await can(user, 'reports.view');
  const canExportRole = ['admin', 'secretary', 'mgmt'].includes(String(user && user.role || ''));
  const canExport = canExportRole && await can(user, 'reports.export');
  const eventDetailPerm = await can(user, 'reports.event.detail');
  let forcedEvent = null;
  if (forcedEventId) {
    forcedEvent = findEvent(forcedEventId);
    if (!forcedEvent) {
      return mount(root, el('div', { class: 'card card-pad' },
        el('h2', { text: 'Event not found' }),
        el('p', { class: 'sub', text: 'The event-specific report link is invalid.' })
      ));
    }
    const onForEvent = await isEventOn('reporting.event_detail_signedin', forcedEvent);
    if (!onForEvent) {
      return mount(root, el('div', { class: 'card card-pad' },
        el('h2', { text: 'Report not enabled' }),
        el('p', { class: 'sub', text: 'Detailed list report is not enabled for this event.' })
      ));
    }
    const ok = await canViewEventDetailedReport(forcedEvent, user, allowed || eventDetailPerm);
    if (!ok) {
      return mount(root, el('div', { class: 'card card-pad' },
        el('h2', { text: 'No access' }),
        el('p', { class: 'sub', text: 'This event report is restricted to allowed resident emails or committee roles.' })
      ));
    }
  }
  if (!allowed && !forcedEventId) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'No access' }),
      el('p', { class: 'sub', text: 'Ask an admin to grant reports.view on your role.' })
    ));
  }
  const exportOn = await isSystemOn('reporting.export');
  if (!exportOn && !forcedEventId) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Reports export is turned off' }),
      el('p', { class: 'sub', text: 'An admin can enable "reporting.export" in Admin → Feature registry.' })
    ));
  }

  const events = [...state.events()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const users  = state.users();
  const userById = new Map(users.map(u => [u.id, u]));
  const evtById  = new Map(events.map(e => [e.id, e]));
  const saved = loadFilters();

  const st = {
    scope:    forcedEventId ? 'events' : (saved.scope || 'published'),  // 'all' | 'published' | 'events' | 'range'
    eventIds: forcedEventId ? [forcedEventId] : (saved.eventIds || []),
    range:    saved.range    || 'monthly',    // 'monthly' | 'yearly' | 'custom'
    from:     saved.from     || '',
    to:       saved.to       || '',
    downloadEventId: saved.downloadEventId || '',
    statuses: saved.statuses || ['verified'],
    groupBy:  saved.groupBy  || 'event',      // 'none' | 'event' | 'month' | 'year' | 'method'
    columns:  saved.columns  || DEFAULT_COLS.filter(c => c.default).map(c => c.id),
    title:    saved.title    || '',
  };

  const head = el('div', {},
    el('h1', { text: 'Reports' }),
    el('p', { class: 'sub', text: forcedEvent
      ? `Event report list view · ${forcedEvent.title}`
      : 'Export contribution data as PDF — one event, several events, or a whole month / year, then archive to the private repo.' })
  );

  const filtersCard = el('section', { class: 'card card-pad' });
  const summaryCard = el('section', { class: 'card card-pad' });
  const tableCard   = el('section', { class: 'card card-pad' });

  function renderFilters() {
    clear(filtersCard);
    const nodes = [
      el('h3', { text: 'What to report' }),
      row('Report title (optional)',
        el('input', { type: 'text', maxlength: '120', value: st.title, placeholder: 'e.g. Ganeshotsav 2026 — verified collections',
          on: { input: e => { st.title = e.target.value; } } })
      ),
      section('Scope',
        radios('scope', st.scope, [
          { v: 'published', label: 'Published events only' },
          { v: 'all',       label: 'All events (any status)' },
          { v: 'events',    label: 'Select specific events…' },
          { v: 'range',     label: 'Date range (monthly / yearly)' },
        ], v => {
          if (forcedEventId) return;
          st.scope = v; renderFilters(); refresh();
        })
      ),
      section('Status',
        el('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap' },
          ...STATUSES.map(s => check(s, st.statuses.includes(s), on => {
            st.statuses = on ? [...new Set([...st.statuses, s])] : st.statuses.filter(x => x !== s);
            refresh();
          }))
        )
      ),
      downloadEventPicker(),
      section('Group summary by',
        radios('groupBy', st.groupBy, [
          { v: 'event',   label: 'Event' },
          { v: 'month',   label: 'Month' },
          { v: 'quarter', label: 'Quarter' },
          { v: 'year',    label: 'Year' },
          { v: 'method',  label: 'Payment method' },
          { v: 'none',    label: 'None' },
        ], v => { st.groupBy = v; refresh(); })
      ),
      section('Columns',
        el('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap' },
          ...DEFAULT_COLS.map(c => check(c.label, st.columns.includes(c.id), on => {
            st.columns = on ? [...new Set([...st.columns, c.id])] : st.columns.filter(x => x !== c.id);
            refresh();
          }))
        )
      ),
    ];
    if (st.scope === 'events') nodes.splice(3, 0, eventPicker());
    if (st.scope === 'range' && !forcedEventId) nodes.splice(4, 0, dateRange());
    filtersCard.append(...nodes);
  }

  function eventPicker() {
    if (forcedEventId) {
      return section('Event', el('p', { class: 'sub', text: forcedEvent ? forcedEvent.title : forcedEventId }));
    }
    return section('Events (pick one or many)',
      events.length ? el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px' },
        ...events.map(e => check(
          `${e.title} · ${e.status || 'draft'}`,
          st.eventIds.includes(e.id),
          on => {
            st.eventIds = on ? [...new Set([...st.eventIds, e.id])] : st.eventIds.filter(x => x !== e.id);
            refresh();
          }
        ))
      ) : el('p', { class: 'sub', text: 'No events on record yet.' })
    );
  }

  function dateRange() {
    return section('Range',
      el('div', {},
        el('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap;align-items:center' },
          el('label', {}, el('span', { text: 'Granularity: ' }),
            el('select', { on: { change: e => { st.range = e.target.value; st.from = ''; st.to = ''; renderFilters(); refresh(); } } },
              el('option', { value: 'monthly', selected: st.range === 'monthly' }, 'Monthly'),
              el('option', { value: 'yearly',  selected: st.range === 'yearly'  }, 'Yearly'),
              el('option', { value: 'custom',  selected: st.range === 'custom'  }, 'Custom (day-precise)'),
            )
          )
        ),
        el('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap;margin-top:8px' },
          el('label', {}, el('span', { text: 'From ' }), el('input', {
            type: st.range === 'yearly' ? 'number' : st.range === 'monthly' ? 'month' : 'date',
            value: st.from, min: st.range === 'yearly' ? '2000' : undefined, max: st.range === 'yearly' ? '2099' : undefined,
            on: { input: e => { st.from = e.target.value; refresh(); } }
          })),
          el('label', {}, el('span', { text: 'To ' }), el('input', {
            type: st.range === 'yearly' ? 'number' : st.range === 'monthly' ? 'month' : 'date',
            value: st.to, min: st.range === 'yearly' ? '2000' : undefined, max: st.range === 'yearly' ? '2099' : undefined,
            on: { input: e => { st.to = e.target.value; refresh(); } }
          })),
        )
      )
    );
  }

  function downloadEventPicker() {
    const isLive = (e) => e && e.status === 'published';
    const isPast = (e) => e && (e.status === 'closed' || e.status === 'archived');
    const labelOf = (e) => `${e.title || e.id} · ${e.status || 'draft'}`;
    const live = events.filter(isLive);
    const past = events.filter(isPast);
    const other = events.filter(e => !isLive(e) && !isPast(e));
    return section('Event for download',
      el('label', {},
        el('span', { text: 'Select event: ' }),
        el('select', {
          on: { change: e => { st.downloadEventId = e.target.value || ''; refresh(); } }
        },
          el('option', { value: '', selected: !st.downloadEventId }, 'All selected rows (current filters)'),
          live.length ? el('optgroup', { label: 'Live events' },
            ...live.map(e => el('option', {
              value: e.id,
              selected: st.downloadEventId === e.id,
              text: labelOf(e)
            }))
          ) : null,
          past.length ? el('optgroup', { label: 'Past events' },
            ...past.map(e => el('option', {
              value: e.id,
              selected: st.downloadEventId === e.id,
              text: labelOf(e)
            }))
          ) : null,
          other.length ? el('optgroup', { label: 'Other events' },
            ...other.map(e => el('option', {
              value: e.id,
              selected: st.downloadEventId === e.id,
              text: labelOf(e)
            }))
          ) : null
        )
      ),
      el('small', { class: 'sub', text: 'Includes both live and past events. Pick one event to download its report directly.' })
    );
  }

  function section(title, ...body) {
    return el('div', { style: 'margin-top:14px' },
      el('div', { class: 'lbl', style: 'font-weight:600;margin-bottom:6px', text: title }),
      ...body
    );
  }
  function row(label, node) {
    return el('div', { style: 'margin-top:14px' },
      el('div', { class: 'lbl', style: 'font-weight:600;margin-bottom:6px', text: label }),
      node
    );
  }
  function radios(name, cur, opts, onChange) {
    return el('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap' },
      ...opts.map(o => el('label', { class: 'row', style: 'gap:6px;align-items:center;cursor:pointer' },
        el('input', { type: 'radio', name: 'tvhReport_' + name, value: o.v, checked: cur === o.v,
          on: { change: e => onChange(e.target.value) } }),
        el('span', { text: o.label })
      ))
    );
  }
  function check(label, on, onChange) {
    return el('label', { class: 'row', style: 'gap:6px;align-items:center;cursor:pointer' },
      el('input', { type: 'checkbox', checked: on, on: { change: e => onChange(e.target.checked) } }),
      el('span', { text: label })
    );
  }

  function selectedContribs() {
    let list = [...state.contribs()];
    if (st.scope === 'published') {
      const publishedIds = new Set(events.filter(e => e.status === 'published').map(e => e.id));
      list = list.filter(c => publishedIds.has(c.event));
    }
    if (st.scope === 'events' && st.eventIds.length) list = list.filter(c => st.eventIds.includes(c.event));
    if (st.scope === 'range') {
      const [from, to] = rangeBounds(st);
      if (from) list = list.filter(c => (c.created_at || '') >= from);
      if (to)   list = list.filter(c => (c.created_at || '') <= to);
    }
    if (st.statuses.length && st.statuses.length < STATUSES.length) {
      list = list.filter(c => st.statuses.includes(c.status));
    }
    list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return list;
  }

  function rowsForDownload(rows) {
    if (!st.downloadEventId) return rows;
    return rows.filter(c => c.event === st.downloadEventId);
  }

  function refresh() {
    saveFilters(st);
    const rows = selectedContribs();
    renderSummary(rows);
    renderTable(rows);
  }

  function renderSummary(rows) {
    clear(summaryCard);
    const total = rows.reduce((s, c) => s + Number(c.amount || 0), 0);
    const verified = rows.filter(c => c.status === 'verified');
    const pending  = rows.filter(c => c.status === 'pending');
    const voided   = rows.filter(c => c.status === 'void');
    const contribs = new Set(
      rows.map(c => String(c.contributor_email || c.contributor || '').trim().toLowerCase()).filter(Boolean)
    ).size;
    const uniqFlats = new Set(
      rows.map(c => String(c.flat || '').trim().toLowerCase()).filter(Boolean)
    ).size;
    const eventsInRows = new Set(rows.map(c => c.event)).size;
    const verifiedTotal = verified.reduce((s, c) => s + Number(c.amount || 0), 0);

    /* Expense side of the ledger — same event scope as the currently
     * displayed contribution rows so the treasurer sees inflows and
     * outflows for the exact selection they filtered. */
    const scopedEventIds = new Set(rows.map(c => c.event));
    const expenses = state.expenses().filter(x => x && x.status === 'verified' && (scopedEventIds.size === 0 || scopedEventIds.has(x.event_id)));
    const expenseTotal = expenses.reduce((s, x) => s + Number(x.amount || 0), 0);
    const net = verifiedTotal - expenseTotal;

    const stats = el('div', { class: 'grid grid-4' },
      stat('Total ₹', fmtINR(total), `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`),
      stat('Verified ₹', fmtINR(verifiedTotal), `${verified.length} verified · ${pending.length} pending${voided.length ? ' · ' + voided.length + ' invalid' : ''}`),
      stat('Unique flats', String(uniqFlats), `${contribs} contributor${contribs === 1 ? '' : 's'}`),
      stat('Coverage', `${eventsInRows} event${eventsInRows === 1 ? '' : 's'}`, 'in selection'),
    );

    const groups = groupRows(rows, st.groupBy);
    const summaryNodes = [el('h3', { text: 'Summary' }), stats];
    if (st.groupBy !== 'none' && groups.length) {
      summaryNodes.push(el('div', { style: 'margin-top:14px' },
        el('div', { class: 'lbl', style: 'font-weight:600;margin-bottom:6px', text: `Breakdown by ${labelForGroup(st.groupBy)}` }),
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: labelForGroup(st.groupBy) }),
            el('th', { text: 'Entries' }),
            el('th', { text: 'Verified ₹' }),
            el('th', { text: 'Total ₹' }),
          )),
          el('tbody', {}, ...groups.map(g => el('tr', {},
            el('td', { text: g.label }),
            el('td', { text: String(g.count) }),
            el('td', { text: fmtINR(g.verified) }),
            el('td', { text: fmtINR(g.total) }),
          )))
        )
      ));
    }
    /* Expenses ledger — only rendered when there is at least one
     * expense in the current scope so the section doesn't dead-space
     * blank reports. */
    if (expenses.length) {
      const expenseGroups = new Map();
      for (const x of expenses) {
        const k = String(x.category || 'uncategorised').toLowerCase();
        const g = expenseGroups.get(k) || { key: k, label: x.category || 'Uncategorised', count: 0, total: 0 };
        g.count += 1;
        g.total += Number(x.amount || 0);
        expenseGroups.set(k, g);
      }
      const expBuckets = [...expenseGroups.values()].sort((a, b) => b.total - a.total);
      summaryNodes.push(el('div', { style: 'margin-top:14px' },
        el('div', { class: 'lbl', style: 'font-weight:600;margin-bottom:6px', text: `Expenses in scope (${expenses.length} row${expenses.length === 1 ? '' : 's'} · ${fmtINR(expenseTotal)} spent · ${fmtINR(net)} net)` }),
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: 'Category' }),
            el('th', { text: 'Entries' }),
            el('th', { text: 'Total ₹' }),
          )),
          el('tbody', {}, ...expBuckets.map(g => el('tr', {},
            el('td', { text: g.label }),
            el('td', { text: String(g.count) }),
            el('td', { text: fmtINR(g.total) }),
          )))
        )
      ));
    }
    summaryCard.append(...summaryNodes);
  }

  function labelForGroup(g) {
    return g === 'event' ? 'Event'
      : g === 'month'   ? 'Month'
      : g === 'quarter' ? 'Quarter'
      : g === 'year'    ? 'Year'
      : g === 'method'  ? 'Method'
      : 'Group';
  }

  function groupRows(rows, groupBy) {
    if (groupBy === 'none') return [];
    const keyOf = c => {
      if (groupBy === 'event')   return c.event;
      if (groupBy === 'month')   return (c.created_at || '').slice(0, 7);
      if (groupBy === 'quarter') {
        const iso = c.created_at || '';
        if (iso.length < 7) return '—';
        const y = iso.slice(0, 4);
        const m = Number(iso.slice(5, 7)) || 1;
        const q = Math.ceil(m / 3);
        return y + '-Q' + q;
      }
      if (groupBy === 'year')    return (c.created_at || '').slice(0, 4);
      if (groupBy === 'method')  return c.method || '—';
      return '—';
    };
    const labelOf = k => (groupBy === 'event') ? ((evtById.get(k) && evtById.get(k).title) || k || '—') : (k || '—');
    const buckets = new Map();
    for (const c of rows) {
      const k = keyOf(c);
      const b = buckets.get(k) || { key: k, count: 0, total: 0, verified: 0 };
      b.count += 1;
      b.total += Number(c.amount || 0);
      if (c.status === 'verified') b.verified += Number(c.amount || 0);
      buckets.set(k, b);
    }
    return [...buckets.values()].map(b => ({ ...b, label: labelOf(b.key) })).sort((a, b) => b.total - a.total);
  }

  function renderTable(rows) {
    clear(tableCard);
    const previewCap = 200;
    const shown = rows.slice(0, previewCap);
    const cols = DEFAULT_COLS.filter(c => st.columns.includes(c.id));

    const downloadRows = rowsForDownload(rows);
    const actionNodes = [
      (exportOn && canExport) ? el('button', { class: 'btn', on: { click: () => downloadPDF(downloadRows) } }, '⬇ Download report (PDF)') : null,
      (exportOn && canExport) ? el('button', { class: 'btn btn-sage', on: { click: () => saveToArchive(downloadRows) } }, '☁ Save PDF to archive') : null,
      !exportOn ? el('small', { class: 'sub', text: 'Export actions are disabled by admin. List view remains available.' }) : null,
      (exportOn && !canExport) ? el('small', { class: 'sub', text: 'You can view reports, but PDF download/archive is restricted to roles with reports.export permission.' }) : null,
    ].filter(Boolean);
    const actions = el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-bottom:12px' }, ...actionNodes);

    tableCard.append(
      el('div', { class: 'row row-between', style: 'align-items:center;flex-wrap:wrap;gap:8px' },
        el('h3', { text: 'Preview' }),
        el('span', { class: 'sub', text: rows.length > previewCap ? `Showing first ${previewCap} of ${rows.length}` : `${rows.length} row${rows.length === 1 ? '' : 's'}` })
      ),
      actions,
      rows.length === 0
        ? el('p', { class: 'sub', text: 'No matching contributions. Loosen your filters.' })
        : el('div', { style: 'overflow-x:auto' }, el('table', { class: 'table' },
            el('thead', {}, el('tr', {}, ...cols.map(c => el('th', { text: c.label })))),
            el('tbody', {}, ...shown.map(c => el('tr', {}, ...cols.map(col => el('td', { text: fmtCell(col.id, c) })))))
          ))
    );
  }

  function fmtCell(colId, c) {
    switch (colId) {
      case 'event':       { const e = evtById.get(c.event); return e ? e.title : c.event; }
      case 'contributor': { const u = userById.get(c.contributor); return c.anonymous ? 'Anonymous' : (c.contributor_name || (u && u.name) || c.contributor || '—'); }
      case 'flat':        return c.flat || '—';
      case 'amount':      return fmtINR(Number(c.amount || 0));
      case 'method':      return (c.method || '—').toString();
      case 'status':      return (c.status || '—').toString();
      case 'ref':         return c.ref || '—';
      case 'created_at':  return c.created_at ? fmtDate(c.created_at) : '—';
      case 'verified_at': return c.verified_at ? fmtDate(c.verified_at) : '—';
      case 'remarks':     return c.remarks || '';
      default:            return '';
    }
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const exists = Array.from(document.querySelectorAll('script[src]')).find(s => s.src === src);
      if (exists) {
        if (exists.dataset.ready === '1') { resolve(); return; }
        exists.addEventListener('load', () => resolve(), { once: true });
        exists.addEventListener('error', () => reject(new Error('failed to load ' + src)), { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => { s.dataset.ready = '1'; resolve(); };
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensurePdfLibReady() {
    const hasAutoTable = () => {
      if (!window.jspdf || !window.jspdf.jsPDF) return false;
      const proto = window.jspdf.jsPDF.API || window.jspdf.jsPDF.prototype;
      return !!(proto && typeof proto.autoTable === 'function');
    };
    if (hasAutoTable()) return;
    await loadScriptOnce(JSPDF_URL);
    await loadScriptOnce(AUTOTABLE_URL);
    if (!hasAutoTable()) throw new Error('PDF library did not initialise');
  }

  async function buildPdfDoc(rows) {
    await ensurePdfLibReady();
    const cols = DEFAULT_COLS.filter(c => st.columns.includes(c.id));
    if (!cols.length) throw new Error('Pick at least one column for the report');
    const totalWidth = cols.reduce((sum, c) => sum + (c.id === 'remarks' ? 50 : c.id === 'description' ? 55 : 24), 0);
    const landscape = totalWidth > 200 || cols.length > 7;
    const doc = new window.jspdf.jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();

    const title = st.title || defaultTitle();
    const nowStr = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    /* Header aggregates — total accumulated ₹ + unique-flat count give
     * the reader an at-a-glance summary before they read the table.
     * Verified-only figure is called out so the "official" money is
     * unambiguous (pending rows are still shown in the table). */
    const rupees = rows.reduce((s, c) => s + Number(c.amount || 0), 0);
    const verifiedRows = rows.filter(c => c.status === 'verified');
    const verifiedRupees = verifiedRows.reduce((s, c) => s + Number(c.amount || 0), 0);
    const uniqFlats = new Set(rows.map(c => String(c.flat || '').trim().toLowerCase()).filter(Boolean)).size;
    const uniqContribs = new Set(
      rows.map(c => String(c.contributor_email || c.contributor || '').trim().toLowerCase()).filter(Boolean)
    ).size;
    /* Expense side — mirrors the on-screen summary logic so PDF and
     * screen show identical net-cash figures for the same scope. */
    const scopedEventIds = new Set(rows.map(c => c.event));
    const scopedExpenses = state.expenses().filter(x => x && x.status === 'verified' && (scopedEventIds.size === 0 || scopedEventIds.has(x.event_id)));
    const expenseRupees = scopedExpenses.reduce((s, x) => s + Number(x.amount || 0), 0);
    const netRupees = verifiedRupees - expenseRupees;
    /* Plain-ASCII rupee prefix — jsPDF's default helvetica doesn't ship
     * the ₹ glyph and renders it as a placeholder. Use "Rs." in the PDF
     * body only; the on-screen HTML report keeps the ₹ symbol. */
    const rs = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, pageW, 22, 'F');
    doc.setTextColor(252, 211, 77);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('VIBEHIVE · CONTRIBUTION REPORT', 10, 6.5);
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(13);
    doc.text(title, 10, 13);
    doc.setTextColor(226, 232, 240);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(
      `Generated ${nowStr}  ·  Rows ${rows.length}  ·  Total ${rs(rupees)}  ·  Verified ${rs(verifiedRupees)} (${verifiedRows.length})  ·  Unique flats ${uniqFlats}  ·  Contributors ${uniqContribs}`,
      10,
      19
    );
    /* Second summary line — only rendered when the treasurer has
     * recorded outflows for the scope so the header stays compact
     * for contribution-only reports. */
    if (scopedExpenses.length) {
      doc.text(
        `Expenses ${scopedExpenses.length}  ·  Spent ${rs(expenseRupees)}  ·  Net ${rs(netRupees)}`,
        pageW - 10,
        19,
        { align: 'right' }
      );
    }

    const head = [cols.map(c => c.label)];
    const body = rows.map(r => cols.map(c => String(fmtCell(c.id, r) || '')));
    doc.autoTable({
      head,
      body,
      startY: 26,
      theme: 'grid',      margin: { left: 8, right: 8 },
      styles: { fontSize: 8, cellPadding: 1.4, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [30, 41, 59], textColor: [252, 211, 77], fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    });

    const pages = doc.internal.getNumberOfPages();
    const pageH = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(148, 163, 184);
      doc.text('VibeHive · The Address', 8, pageH - 5);
      doc.text(`Page ${i}/${pages}`, pageW - 8, pageH - 5, { align: 'right' });
    }
    return doc;
  }

  async function downloadPDF(rows) {
    const doc = await buildPdfDoc(rows);
    doc.save(filename('pdf'));
    toast(`PDF downloaded · ${rows.length} row${rows.length === 1 ? '' : 's'}`, 'ok');
  }

  async function saveToArchive(rows) {
    try {
      const soc = await getSociety();
      const archiveCfg = (soc && soc.receipts && soc.receipts.archive) || {};
      if (!archiveCfg.enabled) {
        toast('Archive is off — enable it in Admin → Society settings', 'err');
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16); // YYYY-MM-DDTHH-MM
      const scopeSlug = scopeSlugFor();
      const path = `reports/${scopeSlug}/${stamp}.pdf`;
      const doc = await buildPdfDoc(rows);
      const pdfB64 = String(doc.output('datauristring') || '').split(',')[1] || '';
      if (!pdfB64) throw new Error('Could not generate PDF bytes for archive');
      const res = await queueAndMaybePushArchive({
        path,
        kind: 'report-pdf',
        contentBase64: pdfB64,
        encoding: 'base64',
        createdBy: user.id,
        scope: scopeSlug,
        rows: rows.length,
      }, {
        actor: user.id,
        message: `report-pdf: ${scopeSlug} (${rows.length} rows)`,
      });
      state.audit({ actor: user.id, action: 'report.enqueue', path, rows: rows.length });
      if (res && res.ok && res.commitSha) {
        toast(`Saved PDF to tvh_record · ${rows.length} rows`, 'ok');
      } else {
        toast(`Queued PDF · ${rows.length} rows → ${path} (will retry from outbox)`, 'warn');
      }
    } catch (err) {
      console.error('[reports] archive enqueue failed', err);
      toast('Save to archive failed — see console', 'err');
    }
  }

  function scopeSlugFor() {
    if (st.scope === 'events' && st.eventIds.length === 1) {
      const e = evtById.get(st.eventIds[0]);
      return (e && e.slug) || st.eventIds[0];
    }
    if (st.scope === 'events') return `multi-${st.eventIds.length}`;
    if (st.scope === 'range')  return `range-${(st.from || 'x')}-to-${(st.to || 'x')}`;
    if (st.scope === 'published') return 'published';
    return 'all';
  }

  function defaultTitle() {
    if (st.scope === 'events' && st.eventIds.length === 1) {
      const e = evtById.get(st.eventIds[0]);
      return e ? `${e.title} — contribution report` : 'Event contribution report';
    }
    if (st.scope === 'events')    return `Contribution report — ${st.eventIds.length} events`;
    if (st.scope === 'range')     return `Contributions ${st.from || '…'} → ${st.to || '…'}`;
    if (st.scope === 'published') return 'Contributions — all published events';
    return 'Contribution report — all events';
  }

  function filename(ext) {
    const safe = (defaultTitle() || 'report')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const stamp = new Date().toISOString().slice(0, 10);
    return `vibehive-${safe}-${stamp}.${ext}`;
  }

  renderFilters();
  refresh();
  mount(root, head, filtersCard, summaryCard, tableCard);
}

/* --- shared helpers --- */

function stat(k, v, d) {
  const kids = [
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v })
  ];
  if (d) kids.push(el('div', { class: 'd', text: d }));
  return el('div', { class: 'card stat' }, ...kids);
}

function rangeBounds(st) {
  if (!st.from && !st.to) return [null, null];
  if (st.range === 'monthly') {
    const from = st.from ? st.from + '-01T00:00:00' : null;
    const to   = st.to   ? endOfMonth(st.to) : null;
    return [from, to];
  }
  if (st.range === 'yearly') {
    const from = st.from ? String(st.from) + '-01-01T00:00:00' : null;
    const to   = st.to   ? String(st.to)   + '-12-31T23:59:59' : null;
    return [from, to];
  }
  const from = st.from ? st.from + 'T00:00:00' : null;
  const to   = st.to   ? st.to   + 'T23:59:59' : null;
  return [from, to];
}
function endOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 0);
  return `${ym}-${String(d.getDate()).padStart(2, '0')}T23:59:59`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
