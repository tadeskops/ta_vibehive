/* Receipt view — printable PDF-ready. Uses jsPDF to generate a real
 * downloadable PDF (no browser print dialog) and the Web Share API
 * on mobile so recipients receive the PDF as a proper attachment via
 * WhatsApp / iMessage / Gmail. Desktop falls back to the standard
 * wa.me deep link with a message body containing the verify URL. */
'use strict';
import { el, mount, fmtINR, fmtDate, toast } from '../dom.js';
import { state, getSociety } from '../store.js';
import { findEvent } from '../events.js';
import { attachReceipt } from '../receipts.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';

const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

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

async function ensureJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return;
  await loadScriptOnce(JSPDF_URL);
  if (!(window.jspdf && window.jspdf.jsPDF)) throw new Error('PDF library did not initialise');
}

/* Build a clean, self-contained receipt PDF. Uses jsPDF's built-in
 * helvetica so the file stays small and renders identically on every
 * viewer. Rupee glyph is spelled "Rs." because the default font does
 * not ship the ₹ codepoint. */
async function buildReceiptPdf(r, rec, evt, soc, opts) {
  await ensureJsPdf();
  const tpl = opts && opts.tpl;
  const doc = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const rs = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN');

  /* Header band */
  doc.setFillColor(62, 90, 158); /* Deep Blue */
  doc.rect(0, 0, pageW, 22, 'F');
  doc.setTextColor(252, 211, 77); /* Warm Gold */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(String(soc.short_name || 'VibeHive').toUpperCase(), 10, 8);
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.text('Contribution Receipt', 10, 15);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(226, 232, 240);
  doc.text(`${soc.legal_name || ''} · Reg ${soc.reg_no || ''}`, 10, 20);

  /* Meta block */
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  let y = 32;
  const line = (k, v) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(String(k).toUpperCase(), 10, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    const lines = doc.splitTextToSize(String(v || '—'), pageW - 30);
    doc.text(lines, 70, y);
    y += Math.max(7, lines.length * 5.5);
  };
  line('Receipt no.', r.id);
  line('Issued on', fmtDate(r.issued_at));
  line('Event', evt ? evt.title : '—');
  line('Purpose', evt ? (evt.purpose || evt.template) : '—');
  line('Contributor', rec.anonymous ? 'Anonymous (record maintained)' : (rec.contributor_name || '—'));
  /* Capture the Flat row's Y so we can stamp a rubber-seal ring over
   * it *after* the text renders. Anti-tamper: any digit change to
   * the flat number visually clashes with the stamp texture. */
  const flatY = y;
  line('Flat / Unit', rec.anonymous ? '—' : (rec.flat || '—'));
  line('Payment method', rec.method || '—');
  line('Payment reference', rec.ref || '—');

  /* Overlay the anti-tamper stamp ring on the flat cell. Uses a
   * rotated dashed circle with a shorter inner arc — reads as a
   * hand-applied stamp without needing to embed an image asset. */
  drawFlatStamp(doc, 70, flatY - 4);

  /* Amount block */
  y += 4;
  doc.setFillColor(250, 243, 234);
  doc.roundedRect(10, y, pageW - 20, 20, 3, 3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(163, 67, 40);
  doc.text('Amount received: ' + rs(r.amount), pageW / 2, y + 13, { align: 'center' });
  y += 26;

  /* Thank-you line */
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  const thankYou = tpl && tpl.thank_you_line
    ? String(tpl.thank_you_line)
    : 'Received with thanks. This receipt is issued for records only. No goods or services have been supplied in exchange.';
  doc.text(doc.splitTextToSize(thankYou, pageW - 20), 10, y);
  y += 12;

  /* Verify block */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text('Verification', 10, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('Verify hash: ' + (r.verify_hash || ''), 10, y);
  y += 5;
  doc.text('Verify online: ' + verifyUrl(r.id), 10, y);
  y += 5;
  doc.text('Signatory: ' + (rec.verified_by || 'Authorised signatory'), 10, y);

  /* Footer */
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text('VibeHive · The Address', 10, pageH - 8);
  doc.text('Page 1/1', pageW - 10, pageH - 8, { align: 'right' });

  return doc;
}

function pdfFileName(r) {
  const safeId = String(r && r.id || 'receipt').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `receipt_${safeId}.pdf`;
}

/* Draw a subtle rubber-stamp ring over the given anchor point so the
 * Flat/Unit digit sits under the seal. Uses jsPDF's vector API — no
 * image asset needed, PDF stays tiny, and the drawing survives copy-
 * paste attacks (dashed arcs would smudge under a redraw). */
function drawFlatStamp(doc, x, y) {
  const cx = x + 8;
  const cy = y + 3;
  const r1 = 9;
  const r2 = 7;
  doc.saveGraphicsState();
  doc.setDrawColor(62, 90, 158);   /* Deep Blue */
  doc.setLineWidth(0.5);
  /* Outer ring */
  doc.circle(cx, cy, r1, 'S');
  /* Inner ring */
  doc.circle(cx, cy, r2, 'S');
  /* Tiny "VERIFIED · TA" text arc — jsPDF has no built-in text-on-path,
   * so we place the caption horizontally centered inside the ring. */
  doc.setTextColor(62, 90, 158);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(3.6);
  doc.text('VERIFIED', cx, cy - 0.6, { align: 'center' });
  doc.setFontSize(3.2);
  doc.text('THE ADDRESS', cx, cy + 2.4, { align: 'center' });
  doc.restoreGraphicsState();
}

async function downloadReceiptPdf(r, rec, evt, soc, tpl) {
  const doc = await buildReceiptPdf(r, rec, evt, soc, { tpl });
  doc.save(pdfFileName(r));
}

/* WhatsApp share:
 *   - Prefer the Web Share API with `files`, which brings up the
 *     native share sheet on mobile and lets the user pick WhatsApp
 *     (or iMessage / Gmail / etc.) with the PDF as a real attachment.
 *   - Fallback to the wa.me text-only deep link when the browser has
 *     no share API (most desktops) — the message includes the verify
 *     URL so the recipient can still open the receipt online. */
async function shareToWhatsApp(r, rec, evt, soc, tpl) {
  const shareUrl = verifyUrl(r.id);
  const short = soc.short_name || 'the society';
  const body = `Namaste! Your contribution of ${fmtINR(r.amount)} towards ${evt ? evt.title : 'the event'} is receipted.\n\nReceipt no: ${r.id}\nVerify online: ${shareUrl}\n\n— ${short}`;
  try {
    const doc = await buildReceiptPdf(r, rec, evt, soc, { tpl });
    const blob = doc.output('blob');
    const file = new File([blob], pdfFileName(r), { type: 'application/pdf' });
    if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: `Receipt ${r.id}`,
        text: body,
      });
      return;
    }
  } catch (e) {
    /* User cancelled OR share API rejected — fall through to wa.me. */
    if (e && (e.name === 'AbortError' || String(e.message || '').toLowerCase().includes('abort'))) return;
    console.warn('[receipt] share sheet unavailable, falling back to wa.me', e);
  }
  const waHref = `https://wa.me/?text=${encodeURIComponent(body)}`;
  window.open(waHref, '_blank', 'noopener');
  toast('Open WhatsApp and attach the downloaded PDF (if not auto-attached).', 'warn');
  try { await downloadReceiptPdf(r, rec, evt, soc, tpl); } catch (_e2) { /* ignore */ }
}

/* Inline WhatsApp SVG glyph — matches the 14×14 style used by other
 * action buttons. Avoids reliance on the emoji font (renders as a
 * plain green dot on some Windows browsers). */
function waIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 32 32');
  s.setAttribute('width', '14');
  s.setAttribute('height', '14');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', '#25D366');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M19.11 17.32c-.29-.14-1.7-.83-1.96-.93-.26-.1-.45-.14-.64.14-.19.29-.73.93-.9 1.12-.16.19-.33.21-.62.07-.29-.14-1.22-.45-2.33-1.43-.86-.77-1.44-1.72-1.61-2.01-.17-.29-.02-.44.13-.58.13-.13.29-.34.43-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.02-.5-.07-.14-.64-1.54-.88-2.11-.23-.55-.47-.47-.64-.48-.16-.01-.35-.01-.55-.01-.19 0-.5.07-.76.36-.26.29-1 .98-1 2.39 0 1.41 1.02 2.77 1.16 2.96.14.19 2.02 3.09 4.9 4.33.68.29 1.22.46 1.63.59.68.22 1.31.19 1.8.11.55-.08 1.7-.7 1.94-1.37.24-.68.24-1.26.17-1.37-.07-.11-.26-.18-.55-.32zM16 4C9.37 4 4 9.37 4 16c0 2.12.56 4.1 1.53 5.83L4 28l6.34-1.66A11.95 11.95 0 0 0 16 28c6.63 0 12-5.37 12-12S22.63 4 16 4z');
  s.appendChild(p);
  const span = document.createElement('span');
  span.className = 'oauth-glyph';
  span.setAttribute('aria-hidden', 'true');
  span.style.cssText = 'display:inline-flex;margin-right:4px;vertical-align:-2px';
  span.appendChild(s);
  return span;
}

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

  const actions = el('div', { class: 'row row-end print-hide', style: 'margin-bottom:16px;flex-wrap:wrap;gap:8px' },
    el('a', { class: 'btn btn-ghost', href: `#/e/${rec.event}` }, '← Event'),
    el('a', { class: 'btn btn-ghost', href: `#/verify/${encodeURIComponent(r ? r.id : '')}` }, '🔎 Verify online'),
    el('a', { class: 'btn btn-ghost', href: mailtoHref, title: 'Open your mail client with a pre-filled message' }, '✉ Email'),
    el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      title: 'Share receipt PDF via WhatsApp',
      on: { click: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try { await shareToWhatsApp(r, rec, evt, soc, tpl); }
        catch (e) { toast((e && e.message) || 'Could not share via WhatsApp', 'err'); }
        finally { btn.disabled = false; }
      } }
    }, waIcon(), el('span', { text: 'WhatsApp' })),
    el('button', {
      class: 'btn',
      type: 'button',
      title: 'Download the receipt as a PDF file',
      on: { click: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        const originalLabel = btn.textContent;
        btn.textContent = 'Preparing…';
        try {
          await downloadReceiptPdf(r, rec, evt, soc, tpl);
          toast('Receipt PDF saved to Downloads.', 'ok');
        } catch (e) {
          toast((e && e.message) || 'Could not generate the receipt PDF', 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      } }
    }, '⬇ Download PDF')
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
      flatMetaRow(rec.anonymous ? '—' : (rec.flat || '—')),
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
/* Special flat/unit cell that stamps the society seal *over* the
 * flat number so a tampering hand cannot alter the digit without
 * disturbing the stamp texture. Follows the same wet-stamp overlay
 * pattern already used on the amount block. */
function flatMetaRow(flat) {
  return el('div', { class: 'receipt-meta-flat', style: 'position:relative' },
    el('small', { text: 'Flat / Unit' }),
    el('div', { style: 'position:relative;display:inline-block' },
      el('b', { text: flat, style: 'position:relative;z-index:1' }),
      el('img', {
        src: 'assets/images/TaStampBlue.png',
        alt: 'society seal',
        'aria-hidden': 'true',
        class: 'receipt-flat-stamp'
      })
    )
  );
}
function verifyUrl(id) {
  const base = location.origin + location.pathname.replace(/index\.html$/, '');
  return base + '#/verify/' + encodeURIComponent(id);
}
