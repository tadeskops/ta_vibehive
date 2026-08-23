/* Verify-with-comment prompt.
 * Shared modal used by both contribution- and expense-verify flows so
 * every access-role who marks something "verified" can leave a short
 * note (e.g. cross-checked UPI ref, vendor invoice attached, etc).
 * Resolves to the trimmed comment string on Confirm (empty string is
 * allowed — the field is optional), or null on Cancel.
 */
'use strict';
import { modal, el } from './dom.js';

export function promptVerifyComment(options) {
  const opts = options || {};
  const title = opts.title || 'Verify';
  const subject = opts.subject || '';
  const helpText = opts.helpText || 'Optional — leave a short note that will be saved with the record and shown in the event history.';
  const confirmLabel = opts.confirmLabel || 'Verify';

  return new Promise((resolve) => {
    const textarea = el('textarea', {
      rows: 3,
      maxlength: '240',
      placeholder: 'e.g. UPI ref matches society bank statement, cash counted with treasurer …',
      style: 'width:100%;padding:10px 12px;border:1.5px solid var(--line);border-radius:10px;background:#fff;font-size:14px;font-family:inherit;min-height:80px;resize:vertical',
    });
    const body = el('div', {},
      subject ? el('div', { class: 'row', style: 'gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap' },
        el('small', { class: 'pill pill-muted', text: 'Subject' }),
        el('strong', { text: subject })
      ) : null,
      el('label', { class: 'lbl', style: 'display:block;margin-bottom:6px', text: 'Verification comment' },
        el('span', { class: 'opt-tag', title: helpText, 'aria-label': helpText, text: 'optional' })
      ),
      el('small', { class: 'sub', style: 'display:block;margin-bottom:6px', text: helpText }),
      textarea,
    );
    let resolved = false;
    modal({
      title,
      body,
      actions: [
        { label: 'Cancel', close: true, onClick: (close) => { resolved = true; resolve(null); close(); } },
        { label: confirmLabel, kind: '', onClick: (close) => {
          resolved = true;
          const value = String(textarea.value || '').trim().slice(0, 240);
          resolve(value);
          close();
        } },
      ],
    });
    setTimeout(() => { try { textarea.focus(); } catch (_e) { /* ignore */ } }, 40);
    // Safety net — if the modal is dismissed by other means (Esc etc.)
    // resolve as cancel so callers never hang forever.
    setTimeout(() => { if (!resolved) resolve(null); }, 5 * 60 * 1000);
  });
}
