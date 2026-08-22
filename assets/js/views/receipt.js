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

  /* Active receipt template — a society may keep multiple presets and
   * pick which one drives the render from Settings → Receipt templates.
   * When no template is active (or none exists), the shipped defaults
   * below are used so nothing regresses for existing installs. */
  const templates = state.receiptTemplates() || [];
  const activeTplId = (soc.receipts && soc.receipts.active_template_id) || '';
  const tpl = templates.find(t => t.id === activeTplId) || null;
  const showQr        = tpl ? tpl.show_qr !== false          : true;
  const showGrid      = tpl ? tpl.show_verify_grid !== false : true;
  const showWatermark = tpl ? tpl.show_watermark !== false   : true;
  const headerNote    = tpl && tpl.header_note ? String(tpl.header_note) : '';
  const thankYouLine  = tpl && tpl.thank_you_line
    ? String(tpl.thank_you_line)
    : 'Received with thanks. This receipt is issued for records only. No goods or services have been supplied in exchange.';
  const footerNote    = tpl && tpl.footer_note ? String(tpl.footer_note) : '';
  const sealGlyph     = tpl && tpl.seal_glyph ? String(tpl.seal_glyph) : '';

  /* Share text kept short (WhatsApp UX is best under ~180 chars). The
   * verify URL is the only actionable payload — the recipient clicks
   * it and lands on the public verify page which recomputes the hash. */
  const shareUrl  = verifyUrl(r.id);
  const shareSubject = `Receipt ${r.id} · ${soc.short_name}`;
  const shareBody = `Namaste! Your contribution of ${fmtINR(r.amount)} towards ${evt ? evt.title : 'the event'} is receipted.\n\nReceipt no: ${r.id}\nVerify online: ${shareUrl}\n\n— ${soc.short_name}`;

  /* Prefill mailto recipient only when the contributor field is an email
   * (older records store an id like "aarav@the-address"). Leaves the
   * "To:" field blank otherwise so the user picks the recipient. */
  const looksLikeEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const toEmail = looksLikeEmail(rec.contributor) ? rec.contributor : '';
  const mailtoHref = `mailto:${encodeURIComponent(toEmail)}` +
    `?subject=${encodeURIComponent(shareSubject)}` +
    `&body=${encodeURIComponent(shareBody)}`;
  const waHref = `https://wa.me/?text=${encodeURIComponent(shareBody)}`;

  const actions = el('div', { class: 'row row-end print-hide', style: 'margin-bottom:16px;flex-wrap:wrap;gap:8px' },
    el('a', { class: 'btn btn-ghost', href: `#/e/${rec.event}` }, '← Event'),
    el('a', { class: 'btn btn-ghost', href: `#/verify/${encodeURIComponent(r ? r.id : '')}` }, '🔎 Verify online'),
    el('a', { class: 'btn btn-ghost', href: mailtoHref, title: 'Open your mail client with a pre-filled message' }, '✉ Email'),
    el('a', { class: 'btn btn-ghost', href: waHref, target: '_blank', rel: 'noopener', title: 'Open WhatsApp with a pre-filled message' }, '🟢 WhatsApp'),
    el('button', { class: 'btn', on: { click: () => window.print() } }, '🖨 Download PDF / Print')
  );

  const receipt = el('article', { class: 'receipt' },
    showWatermark ? textmark(soc.short_name, r.id, r.verify_hash) : null,
    el('header', { class: 'receipt-head' },
      el('img', { src: 'assets/images/bee-circle-512.png', alt: '' }),
      el('div', {},
        el('h2', { text: soc.english_name }),
        el('small', { text: `${soc.legal_name} · Reg ${soc.reg_no} · ${soc.location}` })
      )
    ),
    headerNote ? el('p', { style: 'text-align:center;margin:6px 0 0;font-weight:600;color:var(--terra)', text: headerNote }) : null,
    el('h3', { style: 'text-align:center;margin:0 0 8px', text: 'Contribution Receipt' + (sealGlyph ? ' ' + sealGlyph : '') }),
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
    el('p', { style: 'font-size:12px;color:var(--muted)', text: thankYouLine }),
    el('div', { class: 'receipt-stamp' },
      el('div', {},
        el('small', { text: 'For ' + soc.short_name }),
        el('div', { style: 'font-weight:800;margin-top:20px', text: rec.verified_by || 'Authorised signatory' })
      ),
      showGrid ? hashGrid(r.verify_hash) : el('div', {}),
      el('img', { src: 'assets/images/TaStampBlue.png', alt: 'society stamp' })
    ),
    showQr ? el('div', { class: 'receipt-verify' },
      el('div', {}, el('b', { text: 'Verify hash: ' }), el('span', { text: r.verify_hash })),
      el('div', {}, el('b', { text: 'Verify online: ' }), el('span', { text: verifyUrl(r.id) }))
    ) : null,
    footerNote ? el('p', { style: 'text-align:center;font-size:11px;color:var(--muted);margin-top:8px', text: footerNote }) : null,
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
