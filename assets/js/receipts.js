/* Receipt generator.
 * Uses a deterministic naming pattern and produces a PDF via the browser
 * print engine (no third-party PDF lib → no CDN, no supply-chain risk).
 * The generated receipt view carries the society stamp overlay + a
 * verification code that can later be pushed to a private archive repo.
 */
'use strict';
import { state, getSociety } from './store.js';
import { archivePathFor, DEFAULT_ARCHIVE } from './paths.js';
import { queueAndMaybePushArchive } from './archive-runtime.js';

export const RECEIPT_PREFIX = 'TA';

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pad(n, w) { return String(n).padStart(w, '0'); }
function codeFromEvent(evt, fallbackCode, prefixOverride) {
  /* Prefer stable event TYPE (cluster > template) over free-form title so
   * receipt IDs stay consistent even when the organiser edits the event
   * title. Falls back to fallbackCode, prefixOverride, or a generic
   * bucket in that order. */
  const source = String(
    (evt && evt.cluster) ||
    (evt && evt.template) ||
    fallbackCode ||
    (evt && evt.title) ||
    prefixOverride ||
    RECEIPT_PREFIX ||
    'EVENT'
  );
  const raw = source
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (raw || 'EVENT').slice(0, 24);
}
function hasReceiptId(id) {
  return state.contribs().some(c => c && c.receipt && c.receipt.id === id);
}

/* <EVENT_TYPE>-<YYYYMMDD>-<HHMM>
 * Example: FESTIVAL-20260822-1430
 * Seconds are appended only if the minute-level id already exists.
 * A short SHA salt is appended if collisions still occur. */
export async function mintReceiptId(contribution, eventPurposeCode, prefixOverride, evt) {
  const d = new Date(contribution.verified_at || Date.now());
  const code = codeFromEvent(evt, eventPurposeCode, prefixOverride);
  const hh = pad(d.getHours(), 2);
  const mm = pad(d.getMinutes(), 2);
  const ss = pad(d.getSeconds(), 2);
  const day = pad(d.getDate(), 2);
  const mon = pad(d.getMonth() + 1, 2);
  const year = String(d.getFullYear());
  const dateStamp = `${year}${mon}${day}`;
  const base = `${code}-${dateStamp}-${hh}${mm}`;
  if (!hasReceiptId(base)) return base;
  const withSec = `${code}-${dateStamp}-${hh}${mm}${ss}`;
  if (!hasReceiptId(withSec)) return withSec;
  const salt = (await sha256(withSec + '|' + contribution.id)).slice(0, 4).toUpperCase();
  return `${withSec}-${salt}`;
}

export async function attachReceipt(contribution) {
  const soc = await getSociety();
  const evt = state.events().find(e => e.id === contribution.event);
  const code = (evt ? evt.template : 'gen').slice(0, 4).toUpperCase();
  const receiptId = await mintReceiptId(contribution, code, soc.receipts && soc.receipts.prefix, evt);
  const verifyHash = await computeVerifyHash(receiptId, contribution.amount, contribution.contributor);
  const receipt = {
    id: receiptId,
    contribution: contribution.id,
    event: contribution.event,
    amount: contribution.amount,
    issued_at: new Date().toISOString(),
    issued_by_society: soc.short_name,
    verify_hash: verifyHash,
    archive_repo: (soc.receipts && soc.receipts.archive_repo) || null,
    archived: false,
  };
  const list = state.contribs();
  const rec = list.find(c => c.id === contribution.id);
  if (rec) { rec.receipt = receipt; state.saveContribs(list); }
  state.audit({ actor: null, action: 'receipt.mint', receipt: receipt.id });
  /* Archive write: enqueue the JSON metadata + a companion PDF so the
   * society keeps a printable, human-readable receipt alongside the
   * machine-readable audit record. Wrapped in try so archiving never
   * blocks receipt issuance. */
  try {
    const archiveCfg = (soc.receipts && soc.receipts.archive) || DEFAULT_ARCHIVE;
    if (archiveCfg.enabled) {
      const jsonPath = archivePathFor(rec || contribution, evt, archiveCfg);
      const pdfPath = jsonPath.replace(/\.json$/i, '.pdf');
      const content = JSON.stringify({
        receipt,
        contribution: { id: contribution.id, event: contribution.event, amount: contribution.amount, contributor: contribution.contributor, flat: contribution.flat, verified_at: contribution.verified_at },
        society: { id: soc.id, short_name: soc.short_name },
      }, null, 2);
      await queueAndMaybePushArchive({ path: jsonPath, content, receiptId: receipt.id, contribId: contribution.id }, {
        actor: contribution.verified_by || contribution.created_by || null,
        message: `receipt: ${receipt.id}`,
      });
      try {
        const pdfB64 = await buildReceiptPdfBase64(receipt, rec || contribution, evt, soc);
        if (pdfB64) {
          await queueAndMaybePushArchive({
            path: pdfPath,
            encoding: 'base64',
            contentBase64: pdfB64,
            receiptId: receipt.id,
            contribId: contribution.id,
          }, {
            actor: contribution.verified_by || contribution.created_by || null,
            message: `receipt-pdf: ${receipt.id}`,
          });
        }
      } catch (_pdfErr) { /* PDF build is best-effort; JSON already archived */ }
    }
  } catch (_e) { /* archive is best-effort */ }
  return receipt;
}

async function buildReceiptPdfBase64(receipt, contribution, evt, soc) {
  if (typeof window === 'undefined') return null;
  try {
    const mod = await import('./views/receipt.js');
    if (!mod || typeof mod.buildReceiptPdf !== 'function') return null;
    const doc = await mod.buildReceiptPdf(receipt, contribution, evt, soc, {});
    if (!doc) return null;
    const dataUri = String(doc.output('datauristring') || '');
    const comma = dataUri.indexOf(',');
    return comma >= 0 ? dataUri.slice(comma + 1) : '';
  } catch (_e) {
    return null;
  }
}

/** Verify-hash algorithm — the ONE source of truth. Change ⇒ every past receipt
 *  invalidates, so this signature is intentionally frozen. */
export async function computeVerifyHash(receiptId, amount, contributor) {
  return (await sha256(receiptId + '|' + amount + '|' + contributor)).slice(0, 32);
}

/** Look up a contribution by receipt id.
 *  v0.2 tier: reads local state only. v0.3 will fall back to a fetch()
 *  against the private archive repo. Same signature. */
export function findByReceiptId(receiptId) {
  return state.contribs().find(c => c.receipt && c.receipt.id === receiptId) || null;
}
