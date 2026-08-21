/* Receipt generator.
 * Uses a deterministic naming pattern and produces a PDF via the browser
 * print engine (no third-party PDF lib → no CDN, no supply-chain risk).
 * The generated receipt view carries the society stamp overlay + a
 * verification code that can later be pushed to a private archive repo.
 */
'use strict';
import { state, getSociety } from './store.js';
import { archivePathFor, DEFAULT_ARCHIVE } from './paths.js';

export const RECEIPT_PREFIX = 'TA';

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pad(n, w) { return String(n).padStart(w, '0'); }

/** TA-<PURPOSE>-<YYYY>-<MM>-<DD>-<HHMMSS>-<SEQ4>-<HASH8> */
export async function mintReceiptId(contribution, eventPurposeCode) {
  const d = new Date(contribution.verified_at || Date.now());
  const seq = pad((state.contribs().findIndex(c => c.id === contribution.id) + 1) % 10000, 4);
  const stem = [
    RECEIPT_PREFIX, (eventPurposeCode || 'GEN').toUpperCase(),
    d.getUTCFullYear(), pad(d.getUTCMonth() + 1, 2), pad(d.getUTCDate(), 2),
    pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2) + pad(d.getUTCSeconds(), 2),
    seq
  ].join('-');
  const hash = (await sha256(stem + '|' + contribution.id + '|' + contribution.amount)).slice(0, 8).toUpperCase();
  return stem + '-' + hash;
}

export async function attachReceipt(contribution) {
  const soc = await getSociety();
  const evt = state.events().find(e => e.id === contribution.event);
  const code = (evt ? evt.template : 'gen').slice(0, 4).toUpperCase();
  const receiptId = await mintReceiptId(contribution, code);
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
  /* Enqueue archive write. The batched flush (Admin → Settings →
   * "Flush archive queue") pushes ALL pending entries as ONE commit
   * via the GitHub Trees + Commits REST API so we don't spend a
   * commit per receipt. Wrapped in try so a queue hiccup never blocks
   * the receipt itself. */
  try {
    const archiveCfg = (soc.receipts && soc.receipts.archive) || DEFAULT_ARCHIVE;
    if (archiveCfg.enabled) {
      const path = archivePathFor(rec || contribution, evt, archiveCfg);
      const content = JSON.stringify({
        receipt,
        contribution: { id: contribution.id, event: contribution.event, amount: contribution.amount, contributor: contribution.contributor, flat: contribution.flat, verified_at: contribution.verified_at },
        society: { id: soc.id, short_name: soc.short_name },
      }, null, 2);
      state.enqueueArchive({ path, content, receiptId: receipt.id, contribId: contribution.id });
    }
  } catch (_e) { /* archive is best-effort */ }
  return receipt;
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
