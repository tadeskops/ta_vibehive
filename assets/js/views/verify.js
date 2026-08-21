/* Public receipt verify portal — no auth. Recomputes the verify hash and
 * compares against the value stored on the receipt. Discloses only
 * public fields; never personal data.
 */
'use strict';
import { el, mount, fmtINR, fmtDate } from '../dom.js';
import { getSociety } from '../store.js';
import { findEvent } from '../events.js';
import { findByReceiptId, computeVerifyHash } from '../receipts.js';

export async function render(root, { match, params }) {
  const soc = await getSociety();
  const idFromRoute = match && match.id;
  const idFromQuery = params && params.get('id');
  let id = (idFromRoute || idFromQuery || '').trim();

  const input = el('input', { type: 'text', value: id, placeholder: 'TA-…', 'aria-label': 'Receipt ID' });
  const goBtn = el('button', { class: 'btn', on: { click: () => {
    const v = input.value.trim();
    if (!v) return;
    location.hash = '#/verify/' + encodeURIComponent(v);
  } } }, 'Verify');

  const searchCard = el('section', { class: 'card card-pad' },
    el('h1', { text: 'Receipt verification' }),
    el('p', { class: 'sub', text: `Paste any ${soc.short_name} receipt ID to verify it against the tamper-evident hash printed on the document. No login required.` }),
    el('div', { class: 'row', style: 'margin-top:8px' }, input, goBtn)
  );

  let result;
  if (!id) {
    result = el('div', { class: 'card card-pad', style: 'margin-top:16px' },
      el('h3', { text: 'Enter a receipt ID above.' }),
      el('p', { class: 'sub', text: 'Receipt IDs look like TA-FEST-2026-08-22-134502-0001-A1B2C3D4.' })
    );
  } else {
    const contrib = findByReceiptId(id);
    if (!contrib || !contrib.receipt) {
      result = statusCard('unknown', id, null, null, soc);
    } else if (contrib.status === 'void') {
      result = statusCard('void', id, contrib, findEvent(contrib.event), soc);
    } else {
      const expected = await computeVerifyHash(contrib.receipt.id, contrib.amount, contrib.contributor);
      const ok = expected === contrib.receipt.verify_hash;
      result = statusCard(ok ? 'ok' : 'tamper', id, contrib, findEvent(contrib.event), soc);
    }
  }

  mount(root, searchCard, result);
}

function statusCard(kind, id, contrib, evt, soc) {
  const cfgMap = {
    ok:      { cls: 'callout sage',  glyph: '✅', title: 'Receipt verified', note: 'The hash matches. This receipt was issued by the society and has not been altered.' },
    tamper:  { cls: 'callout emerg', glyph: '⚠️', title: 'Hash mismatch',    note: 'The verify hash on the document does not match the stored value. Treat this receipt as invalid and contact the Management Committee.' },
    void:    { cls: 'callout',        glyph: '🚫', title: 'Receipt voided',    note: 'This contribution was voided after issue. Any printed receipt for it must be discarded.' },
    unknown: { cls: 'callout',        glyph: '❔', title: 'Not found',         note: 'No receipt with this ID exists in the society archive. Double-check the ID for typos.' },
  };
  const c = cfgMap[kind];
  const banner = el('div', { class: c.cls, style: 'margin-top:16px' },
    el('div', { class: 'glyph', text: c.glyph }),
    el('div', { style: 'flex:1' },
      el('div', { class: 'lbl', text: c.title }),
      el('small', { text: c.note })
    ),
    el('span', { class: 'pill ' + (kind === 'ok' ? 'pill-sage' : kind === 'tamper' ? '' : 'pill-muted'), text: kind.toUpperCase() })
  );
  const details = (contrib && contrib.receipt) ? el('section', { class: 'card card-pad', style: 'margin-top:12px' },
    el('h3', { text: 'Public details' }),
    kvRow('Issued by',  soc.english_name || soc.short_name),
    kvRow('Receipt ID', contrib.receipt.id),
    kvRow('Issued on',  fmtDate(contrib.receipt.issued_at)),
    kvRow('Event',      evt ? evt.title : '—'),
    kvRow('Amount',     contrib.hide_amount ? '(withheld)' : fmtINR(contrib.amount)),
    kvRow('Status',     contrib.status),
    el('p', { class: 'sub', style: 'margin-top:10px', text: 'Only fields that the contributor consented to display are shown here. The society retains the full record internally for audit.' })
  ) : null;
  return el('div', {}, banner, details);
}

function kvRow(k, v) {
  return el('div', { class: 'feature-row' },
    el('span', { class: 'name', text: k }),
    el('span', { text: v || '—' })
  );
}
