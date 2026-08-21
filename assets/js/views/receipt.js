/* Receipt view — printable PDF-ready. Uses window.print() for PDF export
 * so no third-party PDF lib is loaded (CSP-safe, supply-chain-safe). */
'use strict';
import { el, mount, fmtINR, fmtDate, toast } from '../dom.js';
import { state, getSociety } from '../store.js';
import { findEvent } from '../events.js';
import { attachReceipt } from '../receipts.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';

export async function render(root, { match }) {
  const contribs = state.contribs();
  const rec = contribs.find(c => c.id === match.id);
  if (!rec) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Contribution not found.' })));
  const evt = findEvent(rec.event);
  const soc = await getSociety();
  const user = session();
  const canView = user && (user.id === rec.contributor || await can(user, 'receipts.download'));
  if (!canView) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Not authorised.' })));

  if (rec.status !== 'verified') {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Pending verification' }),
      el('p', { text: 'The Management Committee has not verified this contribution yet. A receipt is generated only after verification.' }),
      el('a', { class: 'btn', href: `#/e/${rec.event}` }, 'Back to event')
    ));
  }

  if (!rec.receipt) { await attachReceipt(rec); }
  const r = state.contribs().find(c => c.id === rec.id).receipt;

  const actions = el('div', { class: 'row row-end print-hide', style: 'margin-bottom:16px' },
    el('a', { class: 'btn btn-ghost', href: `#/e/${rec.event}` }, '← Event'),
    el('a', { class: 'btn btn-ghost', href: `#/verify/${encodeURIComponent(r ? r.id : '')}` }, '🔎 Verify online'),
    el('button', { class: 'btn', on: { click: () => window.print() } }, '🖨 Download PDF / Print')
  );

  const receipt = el('article', { class: 'receipt' },
    textmark(soc.short_name, r.id, r.verify_hash),
    el('header', { class: 'receipt-head' },
      el('img', { src: 'assets/images/TaLogo.png', alt: '' }),
      el('div', {},
        el('h2', { text: soc.english_name }),
        el('small', { text: `${soc.legal_name} · Reg ${soc.reg_no} · ${soc.location}` })
      )
    ),
    el('h3', { style: 'text-align:center;margin:0 0 8px', text: 'Contribution Receipt' }),
    el('div', { class: 'receipt-meta' },
      metaRow('Receipt no.', r.id),
      metaRow('Issued on', fmtDate(r.issued_at)),
      metaRow('Event', (evt ? evt.title : '—')),
      metaRow('Purpose', (evt ? (evt.purpose || evt.template) : '—')),
      metaRow('Contributor', rec.anonymous ? 'Anonymous (record maintained)' : rec.contributor_name),
      metaRow('Flat / Unit', rec.anonymous ? '—' : (rec.flat || '—')),
      metaRow('Payment method', rec.method || '—'),
      metaRow('Payment reference', rec.ref || '—')
    ),
    /* Single stamp policy: the amount stays clean; the ONE seal is the
     * blue society stamp inside the .receipt-stamp block below. Keeping
     * a second wet-stamp overlay here looked "duplicated" on the page,
     * so it has been removed. */
    el('div', { class: 'receipt-amount-wrap' },
      el('div', { class: 'receipt-total', text: 'Amount received · ' + fmtINR(r.amount) })
    ),
    el('p', { style: 'font-size:12px;color:var(--muted)', text: 'Received with thanks. This receipt is issued for records only. No goods or services have been supplied in exchange.' }),
    el('div', { class: 'receipt-stamp' },
      el('div', {},
        el('small', { text: 'For ' + soc.short_name }),
        el('div', { style: 'font-weight:800;margin-top:20px', text: rec.verified_by || 'Authorised signatory' })
      ),
      hashGrid(r.verify_hash),
      el('img', { src: 'assets/images/TaStampBlue.png', alt: 'society stamp' })
    ),
    el('div', { class: 'receipt-verify' },
      el('div', {}, el('b', { text: 'Verify hash: ' }), el('span', { text: r.verify_hash })),
      el('div', {}, el('b', { text: 'Verify online: ' }), el('span', { text: verifyUrl(r.id) }))
    ),
    /* microtext repeats the receipt ID + hash at 5.5px along the bottom;
     * cannot be reproduced by hand-editing / photocopying without smudging. */
    el('div', { class: 'receipt-microtext', 'aria-hidden': 'true', text: microtextLine(r.id, r.verify_hash) })
  );

  mount(root, actions, receipt);
}

/* --- SVG helpers (createElementNS to avoid innerHTML per CSP posture) --- */
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) n.setAttributeNS(null, k, attrs[k]);
  for (const c of kids) if (c != null) n.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

/** Diagonal tiled text pattern — unique per receipt (uses ID + hash). */
function textmark(shortName, receiptId, hash) {
  const s = svg('svg', { class: 'receipt-textmark', 'aria-hidden': 'true', width: '100%', height: '100%' },
    svg('defs', null,
      svg('pattern', { id: 'wm-' + short12(hash), x: 0, y: 0, width: 260, height: 140, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-28)' },
        svg('text', { x: 0, y: 30, class: 'wm-a' }, 'VERIFIED · ' + String(shortName || '').toUpperCase()),
        svg('text', { x: 0, y: 60, class: 'wm-b' }, receiptId),
        svg('text', { x: 0, y: 90, class: 'wm-c' }, hash.slice(0, 16)),
        svg('text', { x: 0, y: 120, class: 'wm-a' }, 'AUTHENTIC · DO NOT DUPLICATE')
      )
    ),
    svg('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'url(#wm-' + short12(hash) + ')' })
  );
  return s;
}

/** 8×8 hash grid — visual fingerprint derived from the verify hash. */
function hashGrid(hash) {
  const g = svg('svg', { class: 'receipt-hashgrid', viewBox: '0 0 80 80', 'aria-hidden': 'true' });
  g.appendChild(svg('rect', { x: 0, y: 0, width: 80, height: 80, fill: '#faf3ea' }));
  const h = String(hash || '').padEnd(64, '0');
  for (let i = 0; i < 64; i++) {
    const v = parseInt(h[i], 16);
    if (Number.isNaN(v) || v < 8) continue;
    const r = Math.floor(i / 8), c = i % 8;
    g.appendChild(svg('rect', { x: c * 10, y: r * 10, width: 10, height: 10, fill: v > 12 ? '#a34328' : '#3E5A9E' }));
  }
  return g;
}

function short12(s) { return String(s || '').slice(0, 12).replace(/[^A-Za-z0-9]/g, '') || 'x'; }
function microtextLine(id, hash) {
  const chunk = `${id} · ${hash} · `;
  return chunk.repeat(6);
}
function metaRow(k, v) { return el('div', {}, el('small', { text: k }), el('div', {}, el('b', { text: v }))); }
function verifyUrl(id) {
  const base = location.origin + location.pathname.replace(/index\.html$/, '');
  return base + '#/verify/' + encodeURIComponent(id);
}
