/* Approvals / Manage — one place for moderators to verify every
 * pending contribution and expense across the society, plus a
 * rolling activity log of recent verifications so it's clear who
 * cleared what. Access gate: any of `contributions.verify` or
 * `expenses.verify`. Anonymous callers are bounced to sign-in.
 */
'use strict';
import { el, mount, fmtDate, fmtINR, toast, modal, applyResponsiveTableLabels } from '../dom.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { state } from '../store.js';
import { promptVerifyComment } from '../verify-prompt.js';
import { syncFromWorker, lastSyncAt } from '../sync.js';
import { withSavingRing } from '../busy.js';

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function verifyContribAction(rec, evt, user) {
  const subject = `${rec.contributor_name || 'Contributor'}${rec.flat ? ' · Flat ' + rec.flat : ''} · ${fmtINR(Number(rec.amount || 0))} · ${(evt && evt.title) || 'Event'}`;
  const comment = await promptVerifyComment({
    title: 'Verify contribution',
    subject,
    helpText: 'Optional — note anything you cross-checked (UPI reference, bank statement, cash counted with treasurer…). Saved to the event history.',
    confirmLabel: 'Verify & mint receipt',
  });
  if (comment === null) return false;
  const mod = await import('../events.js');
  const receipts = await import('../receipts.js');
  const verified = await mod.verifyContribution(rec.id, user, comment);
  await receipts.attachReceipt(verified);
  toast(`Verified · ${(evt && evt.title) || 'Event'} · receipt minted`, 'ok');
  return true;
}

async function verifyExpenseAction(rec, evt, user) {
  const subject = `${rec.category || 'Expense'} · ${fmtINR(Number(rec.amount || 0))} · ${(evt && evt.title) || ''}`;
  const comment = await promptVerifyComment({
    title: 'Verify this expense?',
    subject,
    helpText: 'Optional — note anything you cross-checked (invoice attached, cash counted, cheque number…). Saved to the event history.',
    confirmLabel: 'Verify expense',
  });
  if (comment === null) return false;
  const list = state.expenses();
  const target = list.find((x) => x && x.id === rec.id);
  if (!target) return false;
  const nowIso = new Date().toISOString();
  target.status = 'verified';
  target.verified_at = nowIso;
  target.verified_by = user && (user.email || user.id) || 'unknown';
  if (comment) target.verified_comment = comment;
  target.updated_at = nowIso;
  state.saveExpenses(list);
  state.audit({ actor: user && user.email || null, action: 'expense.verify', expense: target.id, event: target.event_id, amount: target.amount, comment: comment || undefined });
  if (target._path) {
    try {
      const { verifyExpenseRemote } = await import('../api.js');
      verifyExpenseRemote(target._path, comment).catch(() => { /* silent */ });
    } catch (_e) { /* silent */ }
  }
  try {
    const eventsMod = await import('../events.js');
    if (eventsMod && typeof eventsMod.recordExpenseVerify === 'function') eventsMod.recordExpenseVerify(target, user, comment);
  } catch (_e) { /* silent */ }
  toast('Expense verified. Now counts in the ledger.', 'ok');
  return true;
}

async function voidContribAction(rec, evt, user) {
  const subject = `${rec.contributor_name || 'Contributor'} · ${fmtINR(Number(rec.amount || 0))} · ${(evt && evt.title) || 'Event'}`;
  const comment = await promptVerifyComment({
    title: 'Mark contribution invalid?',
    subject,
    helpText: 'Reason for voiding this row. Saved to the event history.',
    confirmLabel: 'Mark invalid',
  });
  if (comment === null) return false;
  const list = state.contribs();
  const target = list.find((c) => c && c.id === rec.id);
  if (!target) return false;
  target.status = 'void';
  target.updated_at = new Date().toISOString();
  state.saveContribs(list);
  state.audit({ actor: user && user.email || null, action: 'contribution.void', contrib: target.id, event: target.event, comment: comment || undefined });
  if (target._path) {
    try {
      const { voidContributionRemote } = await import('../api.js');
      voidContributionRemote(target._path, comment).catch((e) => {
        console.warn('[contribution void] server call failed; will retry on next sync', e);
      });
    } catch (_e) { /* silent */ }
  }
  toast('Contribution marked invalid.', 'ok');
  return true;
}

function renderContribRow(c, evt, user, canVerifyContrib, canEditContrib, onDone) {
  const proofCell = el('td', {},
    c.ref ? el('div', { style: 'font-family:ui-monospace,monospace;font-size:12px', text: c.ref }) : el('span', { class: 'sub', text: '—' }),
    c.proof_data_url ? el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-top:4px', type: 'button', on: { click: async () => {
      try { const m = await import('./event.js'); m.openProof(c); } catch (_e) { /* silent */ }
    } } }, '🖼 View proof') : null
  );
  const contributorCell = el('td', {},
    el('div', { style: 'font-weight:700', text: c.anonymous ? 'Anonymous' : (c.contributor_name || '—') }),
    el('small', { class: 'sub', style: 'display:block' },
      evt
        ? el('a', { href: `#/e/${evt.id}/manage`, style: 'color:var(--terra);text-decoration:none' }, evt.title || evt.id)
        : el('span', { text: c.event })
    )
  );
  const verifyBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Verify');
  const voidBtn   = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Invalid');
  const editBtn   = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Edit');
  verifyBtn.addEventListener('click', async () => {
    voidBtn.disabled = true;
    try {
      const ok = await withSavingRing(verifyBtn, () => verifyContribAction(c, evt, user), { savingLabel: 'Verifying…', busyLabel: 'Verifying contribution…' });
      if (ok) onDone();
    } catch (e) { toast((e && e.message) || 'Verify failed', 'err'); }
    finally { voidBtn.disabled = false; }
  });
  voidBtn.addEventListener('click', async () => {
    verifyBtn.disabled = true;
    try {
      const ok = await withSavingRing(voidBtn, () => voidContribAction(c, evt, user), { savingLabel: 'Voiding…', busyLabel: 'Voiding contribution…' });
      if (ok) onDone();
    } catch (e) { toast((e && e.message) || 'Void failed', 'err'); }
    finally { verifyBtn.disabled = false; }
  });
  editBtn.addEventListener('click', () => openEditContribDialog(c, evt, user, onDone));
  return el('tr', {},
    el('td', { text: fmtDateTime(c.created_at) }),
    contributorCell,
    el('td', { text: c.anonymous ? '' : (c.flat || '') }),
    el('td', { text: c.method || '—' }),
    proofCell,
    el('td', { class: 'num', text: fmtINR(Number(c.amount || 0)) }),
    el('td', {}, el('span', { class: 'pill warn', text: 'pending' })),
    el('td', {}, el('div', { class: 'row', style: 'gap:6px' },
      canVerifyContrib ? verifyBtn : null,
      canVerifyContrib ? voidBtn : null,
      canEditContrib ? editBtn : null,
      evt ? el('a', { class: 'btn btn-sm btn-ghost', href: `#/e/${evt.id}/manage`, title: 'Open the event Manage view' }, 'Open') : null
    ))
  );
}

/* Contribution editor modal — admin/secretary/mgmt only. Lets the
 * moderator correct name / flat / amount / method / ref / remarks
 * and (re-)upload the transaction receipt when the resident missed
 * something. Server call is fire-and-forget with a rollback shadow
 * copy, matching the expense-edit pattern. Proof data URLs stay
 * local only (never crossed the wire on submit either). */
const EDIT_PROOF_MAX_BYTES = 750 * 1024;
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.onload = () => resolve(String(r.result || ''));
    r.readAsDataURL(file);
  });
}

function openEditContribDialog(c, evt, user, onDone) {
  const draft = {
    contributor_name: c.contributor_name || '',
    flat: c.flat || '',
    contributor_mobile: c.contributor_mobile || '',
    amount: Number(c.amount || 0),
    method: c.method || 'upi',
    ref: c.ref || '',
    remarks: c.remarks || '',
    proof_data_url: c.proof_data_url || '',
    proof_name: c.proof_name || '',
    proof_size: c.proof_size || 0,
  };
  const nameInp = el('input', { type: 'text', value: draft.contributor_name, placeholder: 'Contributor name' });
  const flatInp = el('input', { type: 'text', value: draft.flat, placeholder: 'e.g. A-201' });
  const mobInp  = el('input', { type: 'text', value: draft.contributor_mobile, placeholder: '10-digit mobile' });
  const amtInp  = el('input', { type: 'number', min: '1', value: String(draft.amount) });
  const methodSel = el('select', {},
    el('option', { value: 'upi' }, 'UPI'),
    el('option', { value: 'bank' }, 'Bank transfer'),
    el('option', { value: 'other' }, 'Cash / cheque / other'),
  );
  methodSel.value = draft.method;
  const refInp  = el('input', { type: 'text', value: draft.ref, placeholder: 'UTR / bank ref' });
  const remInp  = el('textarea', { rows: 2 }, draft.remarks);
  const proofInp = el('input', { type: 'file', accept: 'image/*,application/pdf' });
  const proofStatus = el('small', { class: 'sub', style: 'display:block;margin-top:4px' },
    draft.proof_data_url ? `Attached: ${draft.proof_name || 'proof'} · ~${Math.round((draft.proof_size || 0) / 1024)} KB` : 'No proof attached.'
  );
  proofInp.addEventListener('change', async () => {
    const f = proofInp.files && proofInp.files[0];
    if (!f) return;
    if (f.size > EDIT_PROOF_MAX_BYTES) { toast('Attachment must stay under 750 KB.', 'err'); proofInp.value = ''; return; }
    try {
      const url = await readFileAsDataUrl(f);
      draft.proof_data_url = url;
      draft.proof_name = f.name;
      draft.proof_size = f.size;
      proofStatus.textContent = `Attached: ${f.name} · ~${Math.round(f.size / 1024)} KB`;
    } catch (e) { toast(e.message || 'Could not read the file.', 'err'); }
  });
  const removeProofBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Remove attachment');
  removeProofBtn.addEventListener('click', () => {
    draft.proof_data_url = ''; draft.proof_name = ''; draft.proof_size = 0;
    proofInp.value = '';
    proofStatus.textContent = 'No proof attached.';
  });

  const field = (label, input, hint) => el('div', { class: 'field' },
    el('label', {}, el('span', { text: label })),
    input,
    hint ? el('small', { class: 'sub', text: hint }) : null
  );
  const body = el('div', {},
    field('Contributor name', nameInp),
    field('Flat', flatInp),
    field('Mobile', mobInp, '10 digits, +91 accepted.'),
    field('Amount (₹)', amtInp),
    field('Method', methodSel),
    field('Transaction ref', refInp, 'UPI UTR / NEFT ref / cheque no.'),
    field('Remarks (optional)', remInp),
    field('Transaction receipt / proof', el('div', {}, proofInp, proofStatus, draft.proof_data_url ? removeProofBtn : null),
      'Images or PDFs up to 750 KB. Archived to the record repo under year/event/flat so any moderator can view it later.')
  );

  modal({
    title: 'Edit contribution',
    body,
    actions: [
      { label: 'Cancel', close: true },
      { label: 'Save changes', kind: '', onClick: async (close) => {
        const amount = Number(amtInp.value || 0);
        if (!(amount > 0)) { toast('Amount must be positive.', 'err'); return; }
        const nowIso = new Date().toISOString();
        const patch = {
          contributor_name: (nameInp.value || '').trim(),
          flat: (flatInp.value || '').trim(),
          contributor_mobile: (mobInp.value || '').trim(),
          amount,
          method: methodSel.value,
          ref: (refInp.value || '').trim(),
          remarks: (remInp.value || '').trim(),
          proof_data_url: draft.proof_data_url || '',
          proof_name: draft.proof_name || '',
          proof_size: Number(draft.proof_size || 0),
        };
        try {
          const arr = state.contribs();
          const rec = arr.find((x) => x && x.id === c.id);
          if (rec) {
            Object.assign(rec, patch);
            rec.proof_data_url = draft.proof_data_url;
            rec.proof_name = draft.proof_name;
            rec.proof_size = draft.proof_size;
            rec.updated_at = nowIso;
            state.saveContribs(arr);
            state.audit({ actor: user && user.email || null, action: 'contribution.edit', contrib: rec.id, event: rec.event, detail: `by ${user && user.email || 'admin'}` });
          }
        } catch (_e) { /* silent */ }
        if (c._path) {
          try {
            const { updateContribution } = await import('../api.js');
            updateContribution(c._path, patch).catch((e) => {
              console.warn('[contribution edit] server PUT failed; row will re-sync', e);
            });
          } catch (_e) { /* silent */ }
        }
        close();
        toast('Contribution updated.', 'ok');
        if (typeof onDone === 'function') onDone();
      } },
    ],
  });
}

function renderExpenseRow(x, evt, user, canVerifyExpense, onDone) {
  const proofCell = el('td', {},
    x.receipt_url ? el('a', { class: 'btn btn-sm btn-ghost', href: x.receipt_url, target: '_blank', rel: 'noopener' }, '🔗 URL') : null,
    x.proof_data_url ? el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-top:4px', type: 'button', on: { click: async () => {
      try { const m = await import('./event.js'); m.openExpenseProof(x); } catch (_e) { /* silent */ }
    } } }, '🖼 View proof') : null,
    (!x.receipt_url && !x.proof_data_url) ? el('span', { class: 'sub', text: '—' }) : null
  );
  const categoryCell = el('td', {},
    el('div', { style: 'font-weight:700', text: x.category || 'Expense' }),
    el('small', { class: 'sub', style: 'display:block' },
      evt
        ? el('a', { href: `#/e/${evt.id}/manage`, style: 'color:var(--terra);text-decoration:none' }, evt.title || evt.id)
        : el('span', { text: x.event_id })
    ),
    x.created_by ? el('small', { class: 'sub', style: 'display:block;margin-top:2px', text: 'by ' + x.created_by }) : null
  );
  const verifyBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Verify');
  verifyBtn.addEventListener('click', async () => {
    try {
      const ok = await withSavingRing(verifyBtn, () => verifyExpenseAction(x, evt, user), { savingLabel: 'Verifying…', busyLabel: 'Verifying expense…' });
      if (ok) onDone();
    } catch (e) { toast((e && e.message) || 'Verify failed', 'err'); }
  });
  return el('tr', {},
    el('td', { text: fmtDateTime(x.created_at) }),
    categoryCell,
    el('td', { style: 'max-width:260px;white-space:normal', text: x.description || '—' }),
    proofCell,
    el('td', { class: 'num', text: fmtINR(Number(x.amount || 0)) }),
    el('td', {}, el('span', { class: 'pill warn', text: 'pending' })),
    el('td', {}, el('div', { class: 'row', style: 'gap:6px' },
      canVerifyExpense ? verifyBtn : null,
      evt ? el('a', { class: 'btn btn-sm btn-ghost', href: `#/e/${evt.id}/manage`, title: 'Open the event Manage view' }, 'Open') : null
    ))
  );
}

/* Recent-activity log — reads state.audit() entries and filters to
 * the verify/void actions so the page ends with a clear "who did
 * what" tail. Kept to the last 25 relevant entries. */
function renderActivityLog(events) {
  const eventById = new Map(events.map((e) => [e.id, e]));
  const contribById = new Map(state.contribs().map((c) => [c.id, c]));
  const expenseById = new Map(state.expenses().map((x) => [x.id, x]));
  const audits = typeof state.auditLog === 'function' ? state.auditLog() : [];
  const arr = Array.isArray(audits) ? audits : [];
  const filtered = arr.filter((e) => {
    const a = String(e && e.action || '');
    return a === 'contrib.verify' || a === 'contribution.verify' || a === 'contribution.void'
        || a === 'expense.verify' || a === 'expense.void' || a === 'contrib.void';
  }).slice(-25).reverse();
  if (!filtered.length) return el('p', { class: 'sub', style: 'margin:8px 0 0', text: 'No approval actions yet.' });
  return el('table', { class: 'table', style: 'width:100%' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'When' }),
      el('th', { text: 'Actor' }),
      el('th', { text: 'Action' }),
      el('th', { text: 'Subject' }),
      el('th', { text: 'Note' })
    )),
    el('tbody', {}, ...filtered.map((e) => {
      const subject = (() => {
        const c = e.contrib && contribById.get(e.contrib);
        const x = e.expense && expenseById.get(e.expense);
        const evt = e.event && eventById.get(e.event);
        if (c) return `${c.contributor_name || 'Contribution'} · ${fmtINR(Number(c.amount || 0))} · ${(evt && evt.title) || c.event}`;
        if (x) return `${x.category || 'Expense'} · ${fmtINR(Number(x.amount || 0))} · ${(evt && evt.title) || x.event_id}`;
        return String(e.action);
      })();
      const label = (e.action || '').replace(/[._]/g, ' ');
      return el('tr', {},
        el('td', { text: fmtDateTime(e.at || e.time || e.ts) }),
        el('td', { text: e.actor || '—' }),
        el('td', {}, el('small', { class: 'pill ' + (label.includes('void') ? 'pill-muted' : 'ok'), text: label })),
        el('td', { text: subject }),
        el('td', { style: 'max-width:280px;white-space:normal;color:var(--muted);font-size:12px', text: e.comment || '' })
      );
    }))
  );
}

export async function render(root) {
  const user = session();
  if (!user) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Sign in required' }), el('a', { class: 'btn', href: '#/login' }, 'Sign in')));
  const [canVerifyContrib, canVerifyExpense, canEditContrib] = await Promise.all([
    can(user, 'contributions.verify'),
    can(user, 'expenses.verify'),
    can(user, 'contributions.edit'),
  ]);
  if (!canVerifyContrib && !canVerifyExpense) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Not authorised' }),
      el('p', { text: 'You do not have permission to verify contributions or expenses. This page is for the committee.' })
    ));
  }

  const events = state.events();
  const eventById = new Map(events.map((e) => [e.id, e]));

  // Force a fresh sync when the Approvals inbox opens so a resident's
  // submission that beat the 60 s auto-refresh window still shows up
  // immediately. Silent on failure — the render below falls back to
  // whatever the local cache already has.
  let _syncing = false;
  async function refreshFromWorker() {
    if (_syncing) return;
    _syncing = true;
    try { await syncFromWorker(); }
    catch (_e) { /* silent — cache render is the fallback */ }
    finally { _syncing = false; draw(); }
  }
  refreshFromWorker();

  function fmtSince(ts) {
    if (!ts) return 'never';
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    return Math.floor(secs / 3600) + 'h ago';
  }

  function draw() {
    root.textContent = '';
    const pendingContribs = state.contribs()
      .filter((c) => c && c.status === 'pending')
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const pendingExpenses = state.expenses()
      .filter((x) => x && (x.status === 'pending' || !x.status))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    const contribTotal = pendingContribs.reduce((s, c) => s + Number(c.amount || 0), 0);
    const expenseTotal = pendingExpenses.reduce((s, x) => s + Number(x.amount || 0), 0);

    const hero = el('section', { class: 'hero', style: 'padding:20px 24px' },
      el('div', { class: 'row row-between', style: 'flex-wrap:wrap;gap:8px;align-items:flex-start' },
        el('div', { style: 'min-width:0' },
          el('h1', { style: 'margin:0 0 4px', text: 'Approvals' }),
          el('p', { class: 'sub', style: 'margin:0', text:
            `${pendingContribs.length} pending contribution${pendingContribs.length === 1 ? '' : 's'} (${fmtINR(contribTotal)}) · ` +
            `${pendingExpenses.length} pending expense${pendingExpenses.length === 1 ? '' : 's'} (${fmtINR(expenseTotal)})` }),
          el('p', { class: 'sub', style: 'margin:6px 0 0;font-size:11px', text:
            'Cross-event inbox. To add / edit an expense, edit a contribution, or view event history use the Event admin view on each event (the “Open” button on any row jumps there).' })
        ),
        // Refresh chip — last-sync indicator + on-demand pull for
        // committee members who cannot wait for the 60 s auto tick.
        el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          disabled: _syncing ? '' : null,
          title: 'Fetch latest contributions + expenses from the archive.',
          on: { click: refreshFromWorker },
        }, _syncing ? '⻳ Refreshing…' : `⟳ Refresh · ${fmtSince(lastSyncAt())}`)
      )
    );

    const contribCard = el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' },
      el('div', { style: 'padding:14px 16px' },
        el('h3', { style: 'margin:0', text: '📥 Pending contributions' }),
        el('small', { class: 'sub', text: canVerifyContrib ? 'Tap Verify to mint a receipt, Invalid to void. Same columns and behaviour as the per-event Manage view.' : 'You can view; contributions.verify is required to act.' })
      ),
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'When' }),
          el('th', { text: 'Contributor / Event' }),
          el('th', { text: 'Flat' }),
          el('th', { text: 'Method' }),
          el('th', { text: 'Ref / proof' }),
          el('th', { class: 'num', text: 'Amount' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Actions' })
        )),
        el('tbody', {}, ...(pendingContribs.length
          ? pendingContribs.map((c) => renderContribRow(c, eventById.get(c.event), user, canVerifyContrib, canEditContrib, draw))
          : [el('tr', {}, el('td', { colspan: 8, style: 'text-align:center;color:var(--muted);padding:16px', text: 'Nothing waiting for approval — nice work.' }))]
        ))
      )
    );

    const expenseCard = el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' },
      el('div', { style: 'padding:14px 16px' },
        el('h3', { style: 'margin:0', text: '💸 Pending expenses' }),
        el('small', { class: 'sub', text: canVerifyExpense ? 'Tap Verify to add the amount to the event ledger. Same columns and behaviour as the per-event Expenses panel.' : 'You can view; expenses.verify is required to act.' })
      ),
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'When' }),
          el('th', { text: 'Category / Event' }),
          el('th', { text: 'Description' }),
          el('th', { text: 'Receipt' }),
          el('th', { class: 'num', text: 'Amount' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Actions' })
        )),
        el('tbody', {}, ...(pendingExpenses.length
          ? pendingExpenses.map((x) => renderExpenseRow(x, eventById.get(x.event_id), user, canVerifyExpense, draw))
          : [el('tr', {}, el('td', { colspan: 7, style: 'text-align:center;color:var(--muted);padding:16px', text: 'No expenses awaiting verification.' }))]
        ))
      )
    );

    const activity = el('section', { class: 'card card-pad', style: 'margin-top:16px' },
      el('h3', { style: 'margin:0 0 4px', text: '🗂 Recent approval activity' }),
      el('small', { class: 'sub', style: 'display:block;margin-bottom:10px', text: 'Who cleared or voided what — automatically logged for every action taken from any Manage view.' }),
      renderActivityLog(events)
    );

    root.append(hero, contribCard, expenseCard, activity);
    applyResponsiveTableLabels(root);
  }

  draw();
}
