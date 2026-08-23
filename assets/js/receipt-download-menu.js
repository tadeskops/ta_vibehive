/* Inline download menu — replaces the "route to receipt preview with
 * auto-download" flow with a tiny popover that lets the caller pick
 * PDF vs PNG and downloads directly. Keeps the preview page for
 * viewing only. */
'use strict';

import { toast } from './dom.js';
import { downloadReceiptDirect, shareReceiptDirect, downloadExpenseDirect, shareExpenseDirect } from './views/receipt.js';

let _openMenu = null;
function closeOpenMenu() {
  if (_openMenu && _openMenu.parentNode) _openMenu.parentNode.removeChild(_openMenu);
  _openMenu = null;
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKey, true);
}
function onDocClick(ev) { if (_openMenu && !_openMenu.contains(ev.target)) closeOpenMenu(); }
function onKey(ev) { if (ev.key === 'Escape') closeOpenMenu(); }

/** Build an inline icon button that opens a small format menu.
 *  @param {string} contribId
 *  @param {object} [opts] { title, formats: ['pdf','png'] }
 */
export function receiptDownloadIconBtn(contribId, opts) {
  const cfg = opts || {};
  const formats = cfg.formats || ['pdf', 'png'];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tvh-mini-icon-btn';
  btn.textContent = '⬇';
  btn.title = cfg.title || 'Download receipt';
  btn.setAttribute('aria-label', cfg.title || 'Download receipt');
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (_openMenu) { closeOpenMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'tvh-download-menu';
    menu.setAttribute('role', 'menu');
    const label = document.createElement('div');
    label.className = 'tvh-download-menu-label';
    label.textContent = 'Save as';
    menu.appendChild(label);
    formats.forEach((f) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tvh-download-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = f === 'png' ? '🖼  PNG image' : '📄  PDF (A4)';
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeOpenMenu();
        const originalHtml = btn.textContent;
        btn.textContent = '…';
        btn.disabled = true;
        try {
          await downloadReceiptDirect(contribId, f);
          toast(f === 'png' ? 'Receipt PNG saved.' : 'Receipt PDF saved.', 'ok');
        } catch (err) {
          toast((err && err.message) || 'Could not download the receipt.', 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = originalHtml;
        }
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    _openMenu = menu;
    // Position under the button, right-aligned to fit narrow rows.
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    let left = r.right - mw;
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    // Close on outside click / Esc.
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  });
  return btn;
}

/** Inline "Share to WhatsApp" icon. Uses the Web Share API where
 *  available so mobile users get a native share sheet with the PDF
 *  attached; falls back to a wa.me link + auto-download otherwise. */
export function receiptWhatsAppIconBtn(contribId, opts) {
  const cfg = opts || {};
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tvh-mini-icon-btn tvh-mini-icon-whatsapp';
  btn.title = cfg.title || 'Share receipt on WhatsApp';
  btn.setAttribute('aria-label', cfg.title || 'Share receipt on WhatsApp');
  // Green WhatsApp glyph — inline SVG so we don't depend on the
  // emoji font renderer.
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', '#25D366');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M19.11 17.32c-.29-.14-1.7-.83-1.96-.93-.26-.1-.45-.14-.64.14-.19.29-.73.93-.9 1.12-.16.19-.33.21-.62.07-.29-.14-1.22-.45-2.33-1.43-.86-.77-1.44-1.72-1.61-2.01-.17-.29-.02-.44.13-.58.13-.13.29-.34.43-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.02-.5-.07-.14-.64-1.54-.88-2.11-.23-.55-.47-.47-.64-.48-.16-.01-.35-.01-.55-.01-.19 0-.5.07-.76.36-.26.29-1 .98-1 2.39 0 1.41 1.02 2.77 1.16 2.96.14.19 2.02 3.09 4.9 4.33.68.29 1.22.46 1.63.59.68.22 1.31.19 1.8.11.55-.08 1.7-.7 1.94-1.37.24-.68.24-1.26.17-1.37-.07-.11-.26-.18-.55-.32zM16 4C9.37 4 4 9.37 4 16c0 2.12.56 4.1 1.53 5.83L4 28l6.34-1.66A11.95 11.95 0 0 0 16 28c6.63 0 12-5.37 12-12S22.63 4 16 4z');
  svg.appendChild(path);
  btn.appendChild(svg);
  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    const prevChildren = Array.from(btn.childNodes);
    btn.textContent = '…';
    try {
      await shareReceiptDirect(contribId);
    } catch (err) {
      toast((err && err.message) || 'Could not share the receipt.', 'err');
    } finally {
      btn.disabled = false;
      btn.replaceChildren(...prevChildren);
    }
  });
  return btn;
}

/** Expense voucher download menu — same UX as the receipt menu but
 *  targets the expense pipeline (`downloadExpenseDirect`). */
export function expenseDownloadIconBtn(expenseId, opts) {
  const cfg = opts || {};
  const formats = cfg.formats || ['pdf', 'png'];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tvh-mini-icon-btn';
  btn.textContent = '⬇';
  btn.title = cfg.title || 'Download expense voucher';
  btn.setAttribute('aria-label', cfg.title || 'Download expense voucher');
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (_openMenu) { closeOpenMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'tvh-download-menu';
    menu.setAttribute('role', 'menu');
    const label = document.createElement('div');
    label.className = 'tvh-download-menu-label';
    label.textContent = 'Save voucher as';
    menu.appendChild(label);
    formats.forEach((f) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'tvh-download-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = f === 'png' ? '🖼  PNG image' : '📄  PDF (A4)';
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeOpenMenu();
        const originalHtml = btn.textContent;
        btn.textContent = '…';
        btn.disabled = true;
        try {
          await downloadExpenseDirect(expenseId, f);
          toast(f === 'png' ? 'Voucher PNG saved.' : 'Voucher PDF saved.', 'ok');
        } catch (err) {
          toast((err && err.message) || 'Could not download the voucher.', 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = originalHtml;
        }
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    _openMenu = menu;
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    let left = r.right - mw;
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  });
  return btn;
}

/** WhatsApp share icon for an expense voucher. Mirrors
 *  `receiptWhatsAppIconBtn` visuals so both actions read as a set. */
export function expenseWhatsAppIconBtn(expenseId, opts) {
  const cfg = opts || {};
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tvh-mini-icon-btn tvh-mini-icon-whatsapp';
  btn.title = cfg.title || 'Share expense voucher on WhatsApp';
  btn.setAttribute('aria-label', cfg.title || 'Share expense voucher on WhatsApp');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', '#25D366');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M19.11 17.32c-.29-.14-1.7-.83-1.96-.93-.26-.1-.45-.14-.64.14-.19.29-.73.93-.9 1.12-.16.19-.33.21-.62.07-.29-.14-1.22-.45-2.33-1.43-.86-.77-1.44-1.72-1.61-2.01-.17-.29-.02-.44.13-.58.13-.13.29-.34.43-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.02-.5-.07-.14-.64-1.54-.88-2.11-.23-.55-.47-.47-.64-.48-.16-.01-.35-.01-.55-.01-.19 0-.5.07-.76.36-.26.29-1 .98-1 2.39 0 1.41 1.02 2.77 1.16 2.96.14.19 2.02 3.09 4.9 4.33.68.29 1.22.46 1.63.59.68.22 1.31.19 1.8.11.55-.08 1.7-.7 1.94-1.37.24-.68.24-1.26.17-1.37-.07-.11-.26-.18-.55-.32zM16 4C9.37 4 4 9.37 4 16c0 2.12.56 4.1 1.53 5.83L4 28l6.34-1.66A11.95 11.95 0 0 0 16 28c6.63 0 12-5.37 12-12S22.63 4 16 4z');
  svg.appendChild(path);
  btn.appendChild(svg);
  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    const prevChildren = Array.from(btn.childNodes);
    btn.textContent = '…';
    try {
      await shareExpenseDirect(expenseId);
    } catch (err) {
      toast((err && err.message) || 'Could not share the voucher.', 'err');
    } finally {
      btn.disabled = false;
      btn.replaceChildren(...prevChildren);
    }
  });
  return btn;
}
