/* Inline download menu — replaces the "route to receipt preview with
 * auto-download" flow with a tiny popover that lets the caller pick
 * PDF vs PNG and downloads directly. Keeps the preview page for
 * viewing only. */
'use strict';

import { toast } from './dom.js';
import { downloadReceiptDirect } from './views/receipt.js';

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
