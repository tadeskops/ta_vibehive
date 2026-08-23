/* Approvals / Manage — one place for moderators to verify every
 * pending contribution and expense across the society, plus a
 * rolling activity log of recent verifications so it's clear who
 * cleared what. Access gate: any of `contributions.verify` or
 * `expenses.verify`. Anonymous callers are bounced to sign-in.
 */
'use strict';
import { el, mount, fmtDate, fmtINR, toast } from '../dom.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { state } from '../store.js';
import { promptVerifyComment } from '../verify-prompt.js';

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
  toast('Contribution marked invalid.', 'ok');
  return true;
}

function renderContribRow(c, evt, user, canVerifyContrib, onDone) {
  const cells = [
    el('td', { text: fmtDateTime(c.created_at) }),
    el('td', {}, el('div', { style: 'font-weight:700', text: `${c.contributor_name || 'Contributor'}${c.flat ? ' · ' + c.flat : ''}` }),
      el('small', { class: 'sub', style: 'display:block', text: (evt && evt.title) || c.event })),
    el('td', { text: c.method || '—' }),
    el('td', { class: 'num', text: fmtINR(Number(c.amount || 0)) }),
    el('td', {}),
    el('td', {}),
  ];
  const verifyBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Verify');
  const voidBtn   = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Invalid');
  verifyBtn.addEventListener('click', async () => {
    verifyBtn.disabled = true; voidBtn.disabled = true;
    try { if (await verifyContribAction(c, evt, user)) onDone(); } catch (e) { toast((e && e.message) || 'Verify failed', 'err'); }
    finally { verifyBtn.disabled = false; voidBtn.disabled = false; }
  });
  voidBtn.addEventListener('click', async () => {
    verifyBtn.disabled = true; voidBtn.disabled = true;
    try { if (await voidContribAction(c, evt, user)) onDone(); } catch (e) { toast((e && e.message) || 'Void failed', 'err'); }
    finally { verifyBtn.disabled = false; voidBtn.disabled = false; }
  });
  cells[4] = el('td', {}, el('span', { class: 'pill warn', text: 'pending' }));
  cells[5] = el('td', {}, el('div', { class: 'row', style: 'gap:6px' }, canVerifyContrib ? verifyBtn : null, canVerifyContrib ? voidBtn : null));
  return el('tr', {}, ...cells);
}

function renderExpenseRow(x, evt, user, canVerifyExpense, onDone) {
  const verifyBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Verify');
  verifyBtn.addEventListener('click', async () => {
    verifyBtn.disabled = true;
    try { if (await verifyExpenseAction(x, evt, user)) onDone(); } catch (e) { toast((e && e.message) || 'Verify failed', 'err'); }
    finally { verifyBtn.disabled = false; }
  });
  return el('tr', {},
    el('td', { text: fmtDateTime(x.created_at) }),
    el('td', {}, el('div', { style: 'font-weight:700', text: (x.category || 'Expense') + (x.description ? ' · ' + x.description : '') }),
      el('small', { class: 'sub', style: 'display:block', text: `${(evt && evt.title) || x.event_id}${x.created_by ? ' · by ' + x.created_by : ''}` })),
    el('td', { text: 'expense' }),
    el('td', { class: 'num', text: fmtINR(Number(x.amount || 0)) }),
    el('td', {}, el('span', { class: 'pill warn', text: 'pending' })),
    el('td', {}, canVerifyExpense ? verifyBtn : el('small', { class: 'sub', text: '—' }))
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
  const [canVerifyContrib, canVerifyExpense] = await Promise.all([
    can(user, 'contributions.verify'),
    can(user, 'expenses.verify'),
  ]);
  if (!canVerifyContrib && !canVerifyExpense) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Not authorised' }),
      el('p', { text: 'You do not have permission to verify contributions or expenses. This page is for the committee.' })
    ));
  }

  const events = state.events();
  const eventById = new Map(events.map((e) => [e.id, e]));

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
      el('h1', { style: 'margin:0 0 4px', text: 'Approvals' }),
      el('p', { class: 'sub', style: 'margin:0', text:
        `${pendingContribs.length} pending contribution${pendingContribs.length === 1 ? '' : 's'} (${fmtINR(contribTotal)}) · ` +
        `${pendingExpenses.length} pending expense${pendingExpenses.length === 1 ? '' : 's'} (${fmtINR(expenseTotal)})` })
    );

    const contribCard = el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' },
      el('div', { style: 'padding:14px 16px' },
        el('h3', { style: 'margin:0', text: '📥 Pending contributions' }),
        el('small', { class: 'sub', text: canVerifyContrib ? 'Tap Verify to mint a receipt, Invalid to void.' : 'You can view; contributions.verify is required to act.' })
      ),
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'When' }),
          el('th', { text: 'Contributor / Event' }),
          el('th', { text: 'Method' }),
          el('th', { class: 'num', text: 'Amount' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Actions' })
        )),
        el('tbody', {}, ...(pendingContribs.length
          ? pendingContribs.map((c) => renderContribRow(c, eventById.get(c.event), user, canVerifyContrib, draw))
          : [el('tr', {}, el('td', { colspan: 6, style: 'text-align:center;color:var(--muted);padding:16px', text: 'Nothing waiting for approval — nice work.' }))]
        ))
      )
    );

    const expenseCard = el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' },
      el('div', { style: 'padding:14px 16px' },
        el('h3', { style: 'margin:0', text: '💸 Pending expenses' }),
        el('small', { class: 'sub', text: canVerifyExpense ? 'Tap Verify to add the amount to the event ledger.' : 'You can view; expenses.verify is required to act.' })
      ),
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'When' }),
          el('th', { text: 'Category / Event' }),
          el('th', { text: 'Kind' }),
          el('th', { class: 'num', text: 'Amount' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Actions' })
        )),
        el('tbody', {}, ...(pendingExpenses.length
          ? pendingExpenses.map((x) => renderExpenseRow(x, eventById.get(x.event_id), user, canVerifyExpense, draw))
          : [el('tr', {}, el('td', { colspan: 6, style: 'text-align:center;color:var(--muted);padding:16px', text: 'No expenses awaiting verification.' }))]
        ))
      )
    );

    const activity = el('section', { class: 'card card-pad', style: 'margin-top:16px' },
      el('h3', { style: 'margin:0 0 4px', text: '🗂 Recent approval activity' }),
      el('small', { class: 'sub', style: 'display:block;margin-bottom:10px', text: 'Who cleared or voided what — automatically logged for every action taken from any Manage view.' }),
      renderActivityLog(events)
    );

    root.append(hero, contribCard, expenseCard, activity);
  }

  draw();
}
