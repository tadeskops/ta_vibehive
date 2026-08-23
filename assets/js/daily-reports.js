/* Daily event report auto-save.
 *
 * On Home mount for anyone with `reports.export` capability, walk
 * every published + closed event and:
 *   1. Compute a compact JSON snapshot of the event + its
 *      contributions + expenses (verified only for financial totals,
 *      but all rows for the audit trail).
 *   2. Hash the payload.
 *   3. Look up `overrides.reports.state[eventId]` to see when we
 *      last archived and what the hash was.
 *   4. If (a) the hash has changed AND (b) we last archived >24 h
 *      ago (or never), write a fresh snapshot to the private archive
 *      following the naming convention:
 *        reports/<eventCodeLower>/<societyPrefix>_<eventCode>_<DDMMYYYY>_<HHMMSS>.json
 *   5. Persist the new hash + timestamp to overrides so we never
 *      double-write.
 *
 * Fire-and-forget: swallows all errors; never blocks the dashboard.
 */
'use strict';

import { state, getSociety } from './store.js';
import { queueAndMaybePushArchive } from './archive-runtime.js';
import { STATUS } from './events.js';
import { renderPathTemplate, sanitizeForPath, DEFAULT_ARCHIVE } from './paths.js';

const REPORT_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 h — daily-ish with tolerance
let _ran = false;

function pad2(n) { return String(n).padStart(2, '0'); }
function stampDDMMYYYY_HHMMSS(d) {
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function societyPrefix(soc) {
  const p = (soc && soc.receipts && soc.receipts.prefix) || (soc && soc.id) || 'TVH';
  return String(p).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'TVH';
}
function eventCode(evt) {
  const code = (evt && evt.template) || 'gen';
  return String(code).slice(0, 4).toUpperCase();
}

async function sha256Hex(text) {
  if (typeof crypto === 'undefined' || !crypto.subtle) return '';
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function buildEventSnapshot(evt, contribs, expenses) {
  const rowsC = contribs
    .filter((c) => c && c.event === evt.id)
    .map((c) => ({
      id: c.id,
      created_at: c.created_at,
      contributor: c.anonymous ? 'anonymous' : (c.contributor_name || c.contributor || null),
      flat: c.flat || null,
      amount: Number(c.amount || 0),
      status: c.status,
      method: c.method || null,
      ref: c.ref || null,
      verified_by: c.verified_by || null,
      verified_at: c.verified_at || null,
      receipt_id: (c.receipt && c.receipt.id) || null,
    }));
  const rowsE = expenses
    .filter((x) => x && x.event_id === evt.id)
    .map((x) => ({
      id: x.id,
      created_at: x.created_at,
      category: x.category || null,
      note: x.note || null,
      amount: Number(x.amount || 0),
      status: x.status || null,
      created_by: x.created_by || null,
      verified_by: x.verified_by || null,
      verified_at: x.verified_at || null,
    }));
  const verifiedTotal = rowsC.filter((r) => r.status === 'verified').reduce((s, r) => s + r.amount, 0);
  const expenseTotal  = rowsE.filter((r) => r.status === 'verified').reduce((s, r) => s + r.amount, 0);
  return {
    schema: 'tvh.event-report.v1',
    generated_at: new Date().toISOString(),
    event: {
      id: evt.id,
      slug: evt.slug || null,
      title: evt.title || null,
      template: evt.template || null,
      status: evt.status,
      goal: Number(evt.goal || 0),
      starts_at: evt.starts_at || null,
      ends_at: evt.ends_at || null,
    },
    totals: {
      verified_income: verifiedTotal,
      pending_income: rowsC.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount, 0),
      verified_expense: expenseTotal,
      net: verifiedTotal - expenseTotal,
      contributors: new Set(rowsC.filter((r) => r.status !== 'void' && r.flat).map((r) => String(r.flat).trim().toLowerCase())).size,
    },
    contributions: rowsC,
    expenses: rowsE,
  };
}

async function persistReportState(eventId, hash, path) {
  try {
    const cur = state.societyOverrides() || {};
    const reports = { ...(cur.reports || {}) };
    const st = { ...(reports.state || {}) };
    st[eventId] = { hash, path, at: new Date().toISOString() };
    reports.state = st;
    const next = { ...cur, reports };
    state.saveSocietyOverrides(next);
  } catch (_e) { /* ignore */ }
}

function priorReportState(eventId) {
  try {
    const cur = state.societyOverrides() || {};
    return (cur.reports && cur.reports.state && cur.reports.state[eventId]) || null;
  } catch (_e) { return null; }
}

/** Iterate reportable events and archive a fresh JSON snapshot when
 *  needed. Returns the number of reports written. Never throws. */
export async function runDailyReportsBackfill() {
  if (_ran) return 0;
  _ran = true;
  try {
    const soc = await getSociety();
    if (!soc || !soc.receipts || !soc.receipts.archive || !soc.receipts.archive.enabled) return 0;
    const archiveCfg = soc.receipts.archive || {};
    const reportTpl = archiveCfg.perReportPath || DEFAULT_ARCHIVE.perReportPath;
    const events = state.events().filter((e) => e && (e.status === STATUS.PUBLISHED || e.status === STATUS.CLOSED) && e.records_enabled !== false);
    if (!events.length) return 0;
    const contribs = state.contribs();
    const expenses = state.expenses();
    const prefix = societyPrefix(soc);
    let written = 0;
    for (const evt of events) {
      try {
        const payload = buildEventSnapshot(evt, contribs, expenses);
        const json = JSON.stringify(payload, null, 2);
        const hash = await sha256Hex(json);
        const prior = priorReportState(evt.id);
        const priorAt = prior && prior.at ? new Date(prior.at).getTime() : 0;
        const now = Date.now();
        const stale = !prior || (now - priorAt) >= REPORT_MIN_INTERVAL_MS;
        if (prior && prior.hash === hash) continue;      // no change
        if (!stale) continue;                            // too soon
        const code = eventCode(evt);
        const d = new Date();
        const vars = {
          prefix,
          eventCode: code,
          eventCodeLower: code.toLowerCase(),
          eventId: evt.id || '',
          year: String(d.getFullYear()),
          month: pad2(d.getMonth() + 1),
          day: pad2(d.getDate()),
          dateStamp: `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()}`,
          timeStamp: `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`,
          slug: sanitizeForPath(evt.slug || evt.id, 'event'),
        };
        const path = renderPathTemplate(reportTpl, vars)
          .replace(/^\/+/, '')
          .replace(/\.\.+/g, '.');
        const b64 = textToBase64(json);
        const res = await queueAndMaybePushArchive({
          path,
          kind: 'event-report-json',
          encoding: 'base64',
          contentBase64: b64,
          eventId: evt.id,
          sha256: hash,
        }, {
          actor: 'auto:daily-reports',
          message: `event-report: ${path}`,
        });
        if (res && res.ok) {
          await persistReportState(evt.id, hash, path);
          written++;
        }
      } catch (_e) { /* per-event isolation */ }
    }
    return written;
  } catch (_e) { return 0; }
}
