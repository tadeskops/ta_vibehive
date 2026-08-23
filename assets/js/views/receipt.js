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
import { archivePdfIfMissing } from '../archive-runtime.js';
import { archivePathFor, DEFAULT_ARCHIVE } from '../paths.js';

const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const HTML2CANVAS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';

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
export { ensureJsPdf };

async function ensureHtml2Canvas() {
  if (typeof window.html2canvas === 'function') return;
  await loadScriptOnce(HTML2CANVAS_URL);
  if (typeof window.html2canvas !== 'function') throw new Error('html2canvas did not initialise');
}

/* Event-type-aware copy for curated receipt templates.
 * The visual template (cheque-classic / certificate-brand) is fixed
 * to strictly match the two curated designs; only the field labels
 * and title strings change based on the event's cluster/template so a
 * Ganesh Chaturthi receipt reads "Contribution", a picnic reads
 * "Registration", a cricket match reads "Entry", etc. */
function receiptCopyForEvent(evt) {
  const key = String((evt && (evt.template || evt.cluster)) || '').toLowerCase();
  const COPY = {
    festival:  { short: 'Contribution Receipt', long: 'CERTIFICATE OF CONTRIBUTION', purpose: 'Contribution towards', ackNoun: 'contribution' },
    donation:  { short: 'Donation Receipt',     long: 'CERTIFICATE OF DONATION',     purpose: 'Donation towards',     ackNoun: 'donation' },
    emergency: { short: 'Contribution Receipt', long: 'CERTIFICATE OF CONTRIBUTION', purpose: 'Contribution towards', ackNoun: 'contribution' },
    infra:     { short: 'Contribution Receipt', long: 'CERTIFICATE OF CONTRIBUTION', purpose: 'Contribution towards', ackNoun: 'contribution' },
    social:    { short: 'Registration Receipt', long: 'CERTIFICATE OF REGISTRATION', purpose: 'Registration for',     ackNoun: 'registration' },
    sports:    { short: 'Entry Fee Receipt',    long: 'CERTIFICATE OF ENTRY',        purpose: 'Entry fee for',        ackNoun: 'entry fee' },
  };
  return COPY[key] || COPY.festival;
}

/* Build a receipt PDF. Delegates to a per-theme renderer based on
 * `opts.theme` (or `soc.receipts.default_theme`). All renderers share
 * a small set of primitives: helvetica type (small file size, no
 * hindi/marathi glyphs), Rs. instead of ₹, and the drawFlatStamp()
 * anti-tamper ring over the Flat/Unit row. */
async function buildReceiptPdf(r, rec, evt, soc, opts) {
  await ensureJsPdf();
  const themeId = String(
    (opts && opts.theme) ||
    (soc && soc.receipts && soc.receipts.default_theme) ||
    'default'
  ).toLowerCase();
  if (themeId === 'cheque-classic' || themeId === 'cheque_classic') {
    return buildReceiptPdfChequeClassic(r, rec, evt, soc, opts || {});
  }
  if (themeId === 'certificate-brand' || themeId === 'certificate_brand') {
    return buildReceiptPdfCertificateBrand(r, rec, evt, soc, opts || {});
  }
  return buildReceiptPdfDefault(r, rec, evt, soc, opts || {});
}
export { buildReceiptPdf };

async function buildReceiptPdfDefault(r, rec, evt, soc, opts) {
  const tpl = opts && opts.tpl;
  await Promise.all([ensureJsPdf(), ensureHtml2Canvas()]);

  // Build the exact same DOM the on-screen preview uses, mount it in a
  // hidden off-canvas stage sized like an A4 page at ~96dpi, snapshot it
  // with html2canvas, drop the node, then embed the raster into a jsPDF
  // A4 portrait document. Guarantees "preview == PDF" pixel parity.
  const article = buildReceiptArticle(r, rec, evt, soc, tpl);
  const stage = document.createElement('div');
  // Hide the stage off-screen without touching opacity/visibility —
  // html2canvas honours computed styles, so 0.01 opacity would raster
  // an almost-blank page. `left:-20000px` keeps it invisible to the
  // user while retaining full-fidelity paint for the snapshot.
  stage.style.cssText = 'position:fixed;left:-20000px;top:0;z-index:-1;pointer-events:none;background:#faf3ea;padding:24px 20px;width:794px;'; // 794px ≈ A4 width at 96dpi
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:754px;margin:0 auto;';
  wrap.appendChild(article);
  stage.appendChild(wrap);
  document.body.appendChild(stage);

  try {
    // Wait one frame so images (logo, stamp) start loading, then wait
    // for any <img> inside the article to resolve so the snapshot is
    // complete. Without this the raster occasionally captures empty
    // logo/stamp boxes.
    await new Promise(requestAnimationFrame);
    await waitForImages(article);

    const canvas = await window.html2canvas(stage, {
      backgroundColor: '#faf3ea',
      scale: 2,
      useCORS: true,
      allowTaint: false,
      logging: false,
      windowWidth: stage.offsetWidth,
      windowHeight: stage.offsetHeight,
    });
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    const doc = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    // Fit the snapshot to the page while preserving aspect ratio.
    const ratio = canvas.height / canvas.width;
    let drawW = pageW;
    let drawH = pageW * ratio;
    if (drawH > pageH) {
      drawH = pageH;
      drawW = pageH / ratio;
    }
    const offsetX = (pageW - drawW) / 2;
    const offsetY = (pageH - drawH) / 2;
    doc.addImage(imgData, 'JPEG', offsetX, offsetY, drawW, drawH, undefined, 'FAST');
    return doc;
  } finally {
    try { stage.remove(); } catch (_e) { /* ignore */ }
  }
}

function waitForImages(root) {
  const imgs = Array.from(root.querySelectorAll('img'));
  if (!imgs.length) return Promise.resolve();
  return Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }));
}

// Shared builder that produces the .receipt article node. Used by
// render() to show it on-screen and by buildReceiptPdfDefault() to
// snapshot it for the downloaded PDF — same DOM, same styles.
function buildReceiptArticle(r, rec, evt, soc, tpl) {
  const showQr        = tpl ? tpl.show_qr !== false          : true;
  const showGrid      = tpl ? tpl.show_verify_grid !== false : true;
  const showWatermark = tpl ? tpl.show_watermark !== false   : true;
  const headerNote    = tpl && tpl.header_note ? String(tpl.header_note) : '';
  const thankYouLine  = tpl && tpl.thank_you_line
    ? String(tpl.thank_you_line)
    : 'Received with thanks. This receipt is issued for records only. No goods or services have been supplied in exchange.';
  const footerNote    = tpl && tpl.footer_note ? String(tpl.footer_note) : '';
  const sealGlyph     = tpl && tpl.seal_glyph ? String(tpl.seal_glyph) : '';
  return el('article', { class: 'receipt' },
    showWatermark ? textmark(soc.short_name, r.id, r.verify_hash) : null,
    el('header', { class: 'receipt-head' },
      el('img', { src: 'assets/images/TaLogo.png', alt: '' }),
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
    el('div', { class: 'receipt-microtext', 'aria-hidden': 'true', text: microtextLine(r.id, r.verify_hash) })
  );
}

// Fetch a local image and convert to a data URL for jsPDF's addImage.
async function loadImageAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) return null;
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('image read failed'));
    fr.readAsDataURL(blob);
  });
}

/* --- Theme: Cheque Classic ---------------------------------------
 * A5 landscape (210x148 mm). Tabular receipt with a bank-cheque
 * feel: deep-blue left rail, thin horizontal ruled grid, monospace
 * amount box, "PAY TO / RECEIVED FROM" style labels. Optimised for
 * treasurer records and copy-paste attack resistance (dense grid
 * lines that any tampering would misalign). */
function buildReceiptPdfChequeClassic(r, rec, evt, soc, opts) {
  const tpl = opts && opts.tpl;
  const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a5' });
  const pageW = doc.internal.pageSize.getWidth();  /* 210 */
  const pageH = doc.internal.pageSize.getHeight(); /* 148 */
  const rs = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN');

  /* Left rail */
  doc.setFillColor(25, 62, 138);
  doc.rect(0, 0, 12, pageH, 'F');
  /* Society header — centred, blue */
  doc.setTextColor(25, 62, 138);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(String(soc.english_name || soc.short_name || 'VibeHive').toUpperCase(), pageW / 2, 12, { align: 'center' });
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text(`(${String(soc.legal_name || 'The Address Co-op Hsg Society Ltd.')})`, pageW / 2, 17, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(71, 85, 105);
  doc.text(`Reg. ${soc.reg_no || ''}  ·  ${soc.location || 'Baner, Pune'}`, pageW / 2, 22, { align: 'center' });
  /* Divider */
  doc.setDrawColor(25, 62, 138);
  doc.setLineWidth(0.4);
  doc.line(18, 25, pageW - 8, 25);

  /* Title band with faux cheque MICR font vibe */
  doc.setFillColor(240, 246, 255);
  doc.rect(18, 28, pageW - 26, 10, 'F');
  doc.setTextColor(25, 62, 138);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const copy = receiptCopyForEvent(evt);
  doc.text(copy.short.toUpperCase(), pageW / 2, 34.5, { align: 'center' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(`No. ${r.id}   ·   Issued ${fmtDate(r.issued_at)}`, pageW / 2, 37.6, { align: 'center' });

  /* Ruled grid — 4 rows x 2 columns */
  const gridX = 18, gridY = 44, gridW = pageW - 26, gridH = 66;
  const rowH = gridH / 4;
  const colW = gridW / 2;
  doc.setDrawColor(160, 178, 205);
  doc.setLineWidth(0.2);
  /* Outer border */
  doc.rect(gridX, gridY, gridW, gridH);
  /* Row dividers */
  for (let i = 1; i < 4; i++) doc.line(gridX, gridY + rowH * i, gridX + gridW, gridY + rowH * i);
  /* Vertical divider */
  doc.line(gridX + colW, gridY, gridX + colW, gridY + gridH);

  const cell = (col, row, label, value) => {
    const x = gridX + colW * col;
    const y = gridY + rowH * row;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(71, 85, 105);
    doc.text(String(label).toUpperCase(), x + 3, y + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    const lines = doc.splitTextToSize(String(value || '—'), colW - 6);
    doc.text(lines, x + 3, y + 11);
  };
  cell(0, 0, 'Received from', rec.anonymous ? 'Anonymous' : (rec.contributor_name || '—'));
  cell(1, 0, 'Flat / Unit',    rec.anonymous ? '—' : (rec.flat || '—'));
  cell(0, 1, 'Event',          evt ? evt.title : '—');
  cell(1, 1, 'Purpose',        evt ? (evt.purpose || evt.template) : '—');
  cell(0, 2, 'Payment method', rec.method || '—');
  cell(1, 2, 'Txn / Reference', rec.ref || '—');
  cell(0, 3, 'Verified by',    rec.verified_by || 'Authorised signatory');
  cell(1, 3, 'Status',         'VERIFIED');

  /* Stamp overlay on the Flat cell (row 0, col 1) */
  drawFlatStamp(doc, gridX + colW + 22, gridY + 6);

  /* Amount box — right-aligned "cheque" box */
  const amtW = 62, amtH = 16;
  const amtX = pageW - 8 - amtW;
  const amtY = gridY + gridH + 6;
  doc.setDrawColor(25, 62, 138);
  doc.setLineWidth(0.6);
  doc.rect(amtX, amtY, amtW, amtH);
  doc.setFillColor(25, 62, 138);
  doc.rect(amtX, amtY, 18, amtH, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('AMOUNT', amtX + 9, amtY + 9, { align: 'center' });
  doc.setTextColor(25, 62, 138);
  doc.setFontSize(15);
  doc.text(rs(r.amount), amtX + amtW - 3, amtY + 11, { align: 'right' });

  /* Verify caption */
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text('Verify hash · ' + (r.verify_hash || ''), gridX, amtY + 4);
  doc.text('Verify online · ' + verifyUrl(r.id), gridX, amtY + 8);
  doc.setFont('helvetica', 'italic');
  const thankYou = tpl && tpl.thank_you_line
    ? String(tpl.thank_you_line)
    : 'Received with thanks. This receipt is issued for records only.';
  doc.text(doc.splitTextToSize(thankYou, amtX - gridX - 4), gridX, amtY + 13);

  /* Footer */
  doc.setFontSize(6.5);
  doc.setTextColor(160, 178, 205);
  doc.text('VibeHive · ' + copy.short + ' · Cheque Classic template', pageW / 2, pageH - 5, { align: 'center' });

  return doc;
}

/* --- Theme: Certificate Brand ------------------------------------
 * Ornate certificate feel — deep indigo + warm gold accents, ruled
 * inner frame with corner ornaments, gold ribbon behind the amount.
 * A4 landscape (297x210 mm) to give the certificate breathing room.
 * The signatory + verify block sit at the bottom like an award. */
function buildReceiptPdfCertificateBrand(r, rec, evt, soc, opts) {
  const tpl = opts && opts.tpl;
  const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();  /* 297 */
  const pageH = doc.internal.pageSize.getHeight(); /* 210 */
  const rs = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
  const INDIGO = [55, 48, 163];
  const GOLD   = [201, 163, 73];

  /* Outer indigo border ribbon */
  doc.setFillColor(...INDIGO);
  doc.rect(0, 0, pageW, 6, 'F');
  doc.rect(0, pageH - 6, pageW, 6, 'F');
  doc.rect(0, 0, 6, pageH, 'F');
  doc.rect(pageW - 6, 0, 6, pageH, 'F');
  /* Inner gold ruled frame */
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.6);
  doc.rect(12, 12, pageW - 24, pageH - 24);
  /* Corner ornaments — tiny gold diamonds */
  const diamond = (cx, cy) => {
    doc.setFillColor(...GOLD);
    doc.triangle(cx - 3, cy, cx, cy - 3, cx + 3, cy, 'F');
    doc.triangle(cx - 3, cy, cx, cy + 3, cx + 3, cy, 'F');
  };
  diamond(20, 20);
  diamond(pageW - 20, 20);
  diamond(20, pageH - 20);
  diamond(pageW - 20, pageH - 20);

  /* Society header */
  doc.setTextColor(...INDIGO);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(String(soc.short_name || 'THE ADDRESS').toUpperCase(), pageW / 2, 24, { align: 'center' });
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text(String(soc.location || 'Baner, Pune'), pageW / 2, 29, { align: 'center' });

  /* Certificate title */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.setTextColor(...INDIGO);
  const copy = receiptCopyForEvent(evt);
  doc.text(copy.long, pageW / 2, 55, { align: 'center' });
  /* Gold underline */
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.8);
  doc.line(pageW / 2 - 60, 60, pageW / 2 + 60, 60);
  /* Sub-title */
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(11);
  doc.setTextColor(75, 85, 99);
  doc.text('This is to acknowledge with sincere thanks the ' + copy.ackNoun + ' received from', pageW / 2, 70, { align: 'center' });

  /* Contributor line — big serif-ish (helvetica bold) */
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...INDIGO);
  const who = rec.anonymous ? 'ANONYMOUS CONTRIBUTOR' : (rec.contributor_name || '—').toUpperCase();
  doc.text(who, pageW / 2, 82, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(107, 114, 128);
  if (!rec.anonymous) {
    doc.text(`Flat / Unit ${rec.flat || '—'}`, pageW / 2, 88, { align: 'center' });
    drawFlatStamp(doc, pageW / 2 + 38, 84);
  }

  /* Prose */
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(12);
  doc.setTextColor(55, 65, 81);
  const prose = `${copy.purpose} ${(evt && evt.title) || 'the community event'} — purpose: ${(evt && (evt.purpose || evt.template)) || 'community welfare'}.`;
  doc.text(doc.splitTextToSize(prose, pageW - 60), pageW / 2, 100, { align: 'center' });

  /* Gold ribbon amount */
  const amtY = 118, amtH = 22, amtW = 120;
  const amtX = (pageW - amtW) / 2;
  doc.setFillColor(...GOLD);
  doc.rect(amtX, amtY, amtW, amtH, 'F');
  /* Notch corners */
  doc.setFillColor(255, 255, 255);
  doc.triangle(amtX,          amtY + amtH,     amtX + 5,      amtY + amtH,     amtX,          amtY + amtH - 5, 'F');
  doc.triangle(amtX + amtW,   amtY + amtH,     amtX + amtW,   amtY + amtH - 5, amtX + amtW - 5, amtY + amtH,   'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('AMOUNT', amtX + amtW / 2, amtY + 7, { align: 'center' });
  doc.setFontSize(20);
  doc.text(rs(r.amount), amtX + amtW / 2, amtY + 17, { align: 'center' });

  /* Signatory + verify */
  const footY = pageH - 30;
  doc.setDrawColor(...INDIGO);
  doc.setLineWidth(0.2);
  doc.line(30, footY, 100, footY);
  doc.line(pageW - 100, footY, pageW - 30, footY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(55, 65, 81);
  doc.text(rec.verified_by || 'Authorised signatory', 65, footY + 5, { align: 'center' });
  doc.text('Society Secretary', 65, footY + 10, { align: 'center' });
  doc.text('Receipt no. ' + r.id, pageW - 65, footY + 5, { align: 'center' });
  doc.text('Issued ' + fmtDate(r.issued_at), pageW - 65, footY + 10, { align: 'center' });

  /* Verify caption at very bottom */
  doc.setFontSize(7);
  doc.setTextColor(...INDIGO);
  doc.text(`Verify hash ${r.verify_hash || ''}  ·  Verify online: ${verifyUrl(r.id)}`, pageW / 2, pageH - 10, { align: 'center' });

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

async function downloadReceiptPdf(r, rec, evt, soc, tpl, theme) {
  const doc = await buildReceiptPdf(r, rec, evt, soc, { tpl, theme });
  doc.save(pdfFileName(r));
  // Fire-and-forget: mirror the downloaded PDF into the private archive
  // if it isn't already there. Idempotent + corruption-checked.
  archiveReceiptPdfIfMissing(doc, r, rec, evt, soc).catch(() => { /* best-effort */ });
}

export { downloadReceiptPdf };

// Snapshot the same DOM as the PDF renderer to a PNG and download it.
// The receipt article is built off-screen and rastered via html2canvas,
// so image and PDF stay pixel-consistent.
async function downloadReceiptImage(r, rec, evt, soc, tpl) {
  await ensureHtml2Canvas();
  const article = buildReceiptArticle(r, rec, evt, soc, tpl);
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-20000px;top:0;z-index:-1;pointer-events:none;background:#faf3ea;padding:24px 20px;width:794px;';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:754px;margin:0 auto;';
  wrap.appendChild(article);
  stage.appendChild(wrap);
  document.body.appendChild(stage);
  try {
    await new Promise(requestAnimationFrame);
    await waitForImages(article);
    const canvas = await window.html2canvas(stage, {
      backgroundColor: '#faf3ea', scale: 2, useCORS: true, allowTaint: false, logging: false,
    });
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = pdfFileName(r).replace(/\.pdf$/i, '.png');
    document.body.appendChild(a); a.click(); a.remove();
  } finally {
    try { stage.remove(); } catch (_e) { /* ignore */ }
  }
}

export { downloadReceiptImage };

/** High-level programmatic download entry point used by inline icons
 *  on Home/Event so they can skip the preview route entirely. */
export async function downloadReceiptDirect(contribId, format /* 'pdf' | 'png' */) {
  const rec = state.contribs().find(c => c && c.id === contribId);
  if (!rec) throw new Error('Contribution not found.');
  if (rec.status !== 'verified') throw new Error('Only verified contributions have a receipt.');
  if (!rec.receipt) { await attachReceipt(rec); }
  const r = state.contribs().find(c => c.id === rec.id).receipt;
  const evt = findEvent(rec.event);
  const soc = await getSociety();
  const templates = state.receiptTemplates() || [];
  const tpl = templates.find(t => t.active) || null;
  // Prefer the event creator's per-event theme so each event's
  // receipts feel personalised, then society-wide default.
  const theme = (evt && evt.receipt_theme)
    || (soc && soc.receipts && (soc.receipts.theme || soc.receipts.default_theme))
    || 'default';
  if (format === 'png' || format === 'image') return downloadReceiptImage(r, rec, evt, soc, tpl);
  return downloadReceiptPdf(r, rec, evt, soc, tpl, theme);
}

/** Programmatic WhatsApp share used by the inline share icon on
 *  Home / Event contribution rows. Reuses the same code path as the
 *  receipt-page WhatsApp button so behaviour stays consistent. */
export async function shareReceiptDirect(contribId) {
  const rec = state.contribs().find(c => c && c.id === contribId);
  if (!rec) throw new Error('Contribution not found.');
  if (rec.status !== 'verified') throw new Error('Only verified contributions can be shared.');
  if (!rec.receipt) { await attachReceipt(rec); }
  const r = state.contribs().find(c => c.id === rec.id).receipt;
  const evt = findEvent(rec.event);
  const soc = await getSociety();
  const templates = state.receiptTemplates() || [];
  const tpl = templates.find(t => t.active) || null;
  const theme = (evt && evt.receipt_theme)
    || (soc && soc.receipts && (soc.receipts.theme || soc.receipts.default_theme))
    || 'default';
  return shareToWhatsApp(r, rec, evt, soc, tpl, theme);
}

/* ============================================================
 * Expense receipts — mirror of the contribution flow with an
 * expense-flavored article. Same theme choices (default renders as
 * an on-screen article; PDF/PNG reuse the html2canvas snapshot
 * pipeline). Text/attributes come from the expense record.
 * ============================================================ */

function buildExpenseArticle(x, evt, soc) {
  const receiptNo = expenseReceiptId(x);
  return el('article', { class: 'receipt' },
    el('header', { class: 'receipt-head' },
      el('img', { src: 'assets/images/TaLogo.png', alt: '' }),
      el('div', {},
        el('h2', { text: soc.english_name }),
        el('small', { text: `${soc.legal_name} · Reg ${soc.reg_no} · ${soc.location}` })
      )
    ),
    el('h3', { style: 'text-align:center;margin:0 0 8px', text: 'Expense Voucher' }),
    el('div', { class: 'receipt-meta' },
      metaRow('Voucher no.', receiptNo),
      metaRow('Issued on', fmtDate(x.verified_at || x.updated_at || x.created_at)),
      metaRow('Event', (evt ? evt.title : '—')),
      metaRow('Category', x.category || '—'),
      metaRow('Description', x.description || '—'),
      metaRow('Logged by', x.created_by || '—'),
      metaRow('Verified by', x.verified_by || '—'),
      metaRow('Payment reference', x.txn_ref || x.ref || '—')
    ),
    el('div', { class: 'receipt-amount-wrap' },
      el('div', { class: 'receipt-total', text: 'Amount paid · ' + fmtINR(x.amount) })
    ),
    el('p', { style: 'font-size:12px;color:var(--muted)', text:
      'This voucher acknowledges an expense paid out of society funds. Retain for audit.' }),
    el('div', { class: 'receipt-stamp' },
      el('div', {},
        el('small', { text: 'For ' + soc.short_name }),
        el('div', { style: 'font-weight:800;margin-top:20px', text: x.verified_by || 'Authorised signatory' })
      ),
      el('div', {}),
      el('img', { src: 'assets/images/TaStampBlue.png', alt: 'society stamp' })
    ),
    x.verified_comment ? el('p', { style: 'font-size:11px;color:var(--muted);margin-top:6px', text: 'Verifier note · ' + x.verified_comment }) : null
  );
}

function expenseReceiptId(x) {
  const short = (x.category || 'EXP').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4) || 'EXP';
  const iso = String(x.verified_at || x.created_at || new Date().toISOString());
  const stamp = iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 16).replace(':', '');
  const tail = String(x.id || '').slice(-6).toUpperCase();
  return `${short}-${stamp}-${tail || 'XXXXXX'}`;
}

function expensePdfFileName(x) {
  return `expense_${expenseReceiptId(x)}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function buildExpensePdf(x, evt, soc) {
  await Promise.all([ensureJsPdf(), ensureHtml2Canvas()]);
  const article = buildExpenseArticle(x, evt, soc);
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-20000px;top:0;z-index:-1;pointer-events:none;background:#faf3ea;padding:24px 20px;width:794px;';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:754px;margin:0 auto;';
  wrap.appendChild(article);
  stage.appendChild(wrap);
  document.body.appendChild(stage);
  try {
    await new Promise(requestAnimationFrame);
    await waitForImages(article);
    const canvas = await window.html2canvas(stage, { backgroundColor: '#faf3ea', scale: 2, useCORS: true, allowTaint: false, logging: false });
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    const doc = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const ratio = canvas.height / canvas.width;
    let drawW = pageW; let drawH = pageW * ratio;
    if (drawH > pageH) { drawH = pageH; drawW = pageH / ratio; }
    const offsetX = (pageW - drawW) / 2;
    const offsetY = (pageH - drawH) / 2;
    doc.addImage(imgData, 'JPEG', offsetX, offsetY, drawW, drawH, undefined, 'FAST');
    return { doc, canvas };
  } finally {
    try { stage.remove(); } catch (_e) { /* ignore */ }
  }
}

export async function downloadExpenseDirect(expenseId, format /* 'pdf' | 'png' */) {
  const x = state.expenses().find(e => e && e.id === expenseId);
  if (!x) throw new Error('Expense not found.');
  if (x.status !== 'verified') throw new Error('Only verified expenses have a voucher.');
  const evt = findEvent(x.event_id);
  const soc = await getSociety();
  const { doc, canvas } = await buildExpensePdf(x, evt, soc);
  if (format === 'png' || format === 'image') {
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = expensePdfFileName(x).replace(/\.pdf$/i, '.png');
    document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  doc.save(expensePdfFileName(x));
  // Fire-and-forget archive push, similar to receipts. Path template
  // mirrors receipts naming: <eventCodeLower>/<yyyy-mm>/expense_<id>_receipt.pdf
  try {
    const soc2 = soc || (await getSociety());
    const archCfg = (soc2 && soc2.receipts && soc2.receipts.archive) || null;
    if (archCfg && archCfg.enabled) {
      const dataUri = String(doc.output('datauristring') || '');
      const comma = dataUri.indexOf(',');
      const pdfB64 = comma >= 0 ? dataUri.slice(comma + 1) : '';
      if (pdfB64) {
        const code = ((evt && evt.template) || 'gen').slice(0, 4).toLowerCase();
        const iso = new Date().toISOString();
        const ym = iso.slice(0, 7);
        const path = `${code}/${ym}/expense_${expenseReceiptId(x)}_receipt.pdf`;
        archivePdfIfMissing(path, pdfB64, { kind: 'expense-pdf', expenseId: x.id }).catch(() => {});
      }
    }
  } catch (_e) { /* best-effort */ }
}

export async function shareExpenseDirect(expenseId) {
  const x = state.expenses().find(e => e && e.id === expenseId);
  if (!x) throw new Error('Expense not found.');
  if (x.status !== 'verified') throw new Error('Only verified expenses can be shared.');
  const evt = findEvent(x.event_id);
  const soc = await getSociety();
  const { doc } = await buildExpensePdf(x, evt, soc);
  const short = soc.short_name || 'the society';
  const body = `Namaste! Expense voucher for ${x.category || 'a society expense'} of ${fmtINR(x.amount)} towards ${evt ? evt.title : 'the event'}.\n\nVoucher no: ${expenseReceiptId(x)}\n\n— ${short}`;
  try {
    const blob = doc.output('blob');
    const file = new File([blob], expensePdfFileName(x), { type: 'application/pdf' });
    if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `Expense voucher ${expenseReceiptId(x)}`, text: body });
      return;
    }
  } catch (e) {
    if (e && (e.name === 'AbortError' || String(e.message || '').toLowerCase().includes('abort'))) return;
    console.warn('[receipt] expense share sheet unavailable, falling back to wa.me', e);
  }
  openWhatsAppLink(body);
  toast('Open WhatsApp and attach the downloaded voucher.', 'warn');
  doc.save(expensePdfFileName(x));
}

async function archiveReceiptPdfIfMissing(doc, r, rec, evt, soc) {
  const archiveCfg = (soc && soc.receipts && soc.receipts.archive) || DEFAULT_ARCHIVE;
  if (!archiveCfg || !archiveCfg.enabled) return;
  const dataUri = String(doc.output('datauristring') || '');
  const comma = dataUri.indexOf(',');
  const pdfB64 = comma >= 0 ? dataUri.slice(comma + 1) : '';
  if (!pdfB64) return;
  const jsonPath = archivePathFor(rec || {}, evt, archiveCfg);
  const pdfPath = jsonPath.replace(/\.json$/i, '.pdf');
  const user = session();
  await archivePdfIfMissing(pdfPath, pdfB64, {
    kind: 'receipt-pdf',
    receiptId: r && r.id,
    contribId: rec && rec.id,
    actor: user ? (user.email || user.id) : null,
    message: `receipt-pdf: ${r && r.id}`,
  });
}

/* Open a wa.me deep link via a synthetic anchor click so the
 * navigation is treated as user-initiated on mobile (avoids the
 * "popup blocked" behaviour that `window.open` triggers after an
 * `await`, especially on iOS Safari). The wa.me scheme opens the
 * WhatsApp app directly when installed and falls back to Web
 * WhatsApp otherwise. */
function openWhatsAppLink(body) {
  const waHref = `https://wa.me/?text=${encodeURIComponent(body)}`;
  const a = document.createElement('a');
  a.href = waHref;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { a.remove(); } catch (_e) {} }, 0);
}

/* WhatsApp share:
 *   - Prefer the Web Share API with `files`, which brings up the
 *     native share sheet on mobile and lets the user pick WhatsApp
 *     (or iMessage / Gmail / etc.) with the PDF as a real attachment.
 *   - Fallback to the wa.me text-only deep link when the browser has
 *     no share API (most desktops) — the message includes the verify
 *     URL so the recipient can still open the receipt online. */
async function shareToWhatsApp(r, rec, evt, soc, tpl, theme) {
  const shareUrl = verifyUrl(r.id);
  const short = soc.short_name || 'the society';
  const body = `Namaste! Your contribution of ${fmtINR(r.amount)} towards ${evt ? evt.title : 'the event'} is receipted.\n\nReceipt no: ${r.id}\nVerify online: ${shareUrl}\n\n— ${short}`;
  try {
    const doc = await buildReceiptPdf(r, rec, evt, soc, { tpl, theme });
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
  openWhatsAppLink(body);
  toast('Open WhatsApp and attach the downloaded PDF (if not auto-attached).', 'warn');
  try { await downloadReceiptPdf(r, rec, evt, soc, tpl, theme); } catch (_e2) { /* ignore */ }
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

export async function render(root, { match, params }) {
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

  /* Per-download theme override — reads the society default from
   * settings and lets Admin / Secretary / Management Committee flip
   * to Cheque Classic or Certificate Brand for this one download.
   * Below-secretary roles (committee, manager, resident) DO NOT see
   * the picker — they silently get the society-configured default so
   * receipts always look consistent for the household copy.
   * Value flows into `downloadReceiptPdf` / `shareToWhatsApp` via
   * `currentTheme()`. Active-template id takes priority when it maps
   * to one of the shipped presets (`shipped-cheque-classic`,
   * `shipped-certificate-brand`) so operators can pick a theme purely
   * from Settings → Receipt templates without touching the Receipts
   * archive panel. */
  const SHIPPED_THEME_BY_ID = {
    'shipped-default': 'default',
    'shipped-cheque-classic': 'cheque-classic',
    'shipped-certificate-brand': 'certificate-brand',
  };
  const themeFromActive = SHIPPED_THEME_BY_ID[activeTplId] || '';
  // Precedence: event-level theme (set by the event creator) →
  // active-template mapping → society default → hard default.
  const defaultTheme = (evt && evt.receipt_theme)
    || themeFromActive
    || (soc.receipts && (soc.receipts.default_theme || soc.receipts.theme))
    || 'default';
  const canOverrideTheme = user && user.role !== 'resident' && await can(user, 'receipts.theme.override');
  const themePicker = el('select', {
    class: 'btn btn-ghost',
    style: 'min-width:180px',
    title: 'One-off theme override for this download (event default: ' + defaultTheme + ')'
  },
    el('option', { value: 'default',           text: 'Default · Community Warmth' }),
    el('option', { value: 'cheque-classic',    text: 'Cheque Classic · blue grid' }),
    el('option', { value: 'certificate-brand', text: 'Certificate Brand · indigo + gold' })
  );
  themePicker.value = ['default', 'cheque-classic', 'certificate-brand'].includes(defaultTheme) ? defaultTheme : 'default';
  const currentTheme = () => themePicker.value || 'default';

  // Format selector — user chooses PDF or PNG and then hits Download.
  // Autoinit from `?format=png` when the inline icon requested image.
  const formatSelect = el('select', {
    class: 'btn btn-ghost',
    style: 'min-width:120px',
    title: 'Pick file format for download',
    'aria-label': 'File format'
  },
    el('option', { value: 'pdf', text: 'PDF (A4)' }),
    el('option', { value: 'png', text: 'PNG image' })
  );
  const requestedFormat = params && (params.get('format') || params.get('fmt'));
  if (requestedFormat === 'png' || requestedFormat === 'image') formatSelect.value = 'png';
  const currentFormat = () => formatSelect.value || 'pdf';

  const actionKids = [
    el('a', { class: 'btn btn-ghost', href: `#/e/${rec.event}` }, '← Event'),
    el('a', { class: 'btn btn-ghost', href: `#/verify/${encodeURIComponent(r ? r.id : '')}` }, '🔎 Verify online'),
    el('a', { class: 'btn btn-ghost', href: mailtoHref, title: 'Open your mail client with a pre-filled message' }, '✉ Email'),
  ];
  if (canOverrideTheme) actionKids.push(themePicker);
  actionKids.push(formatSelect);
  actionKids.push(
    el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      title: 'Share receipt PDF via WhatsApp',
      on: { click: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try { await shareToWhatsApp(r, rec, evt, soc, tpl, currentTheme()); }
        catch (e) { toast((e && e.message) || 'Could not share via WhatsApp', 'err'); }
        finally { btn.disabled = false; }
      } }
    }, waIcon(), el('span', { text: 'WhatsApp' })),
    el('button', {
      class: 'btn',
      type: 'button',
      title: 'Download the receipt in the selected format',
      on: { click: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        const originalLabel = btn.textContent;
        btn.textContent = 'Preparing…';
        try {
          if (currentFormat() === 'png') {
            await downloadReceiptImage(r, rec, evt, soc, tpl);
            toast('Receipt image saved to Downloads.', 'ok');
          } else {
            await downloadReceiptPdf(r, rec, evt, soc, tpl, currentTheme());
            toast('Receipt PDF saved to Downloads.', 'ok');
          }
        } catch (e) {
          toast((e && e.message) || 'Could not generate the receipt', 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      } }
    }, '⬇ Download')
  );

  const actions = el('div', { class: 'row row-end print-hide', style: 'margin-bottom:16px;flex-wrap:wrap;gap:8px' },
    ...actionKids
  );

  const receipt = buildReceiptArticle(r, rec, evt, soc, tpl);

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
