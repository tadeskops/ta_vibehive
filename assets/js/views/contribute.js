/* Contribute view — resident-facing contribution flow.
 * Honours event feature flags: shows tiers only if contribution.suggested is on,
 * shows anonymous toggle only if privacy.anonymous is on, etc.
 */
'use strict';
import { el, mount, fmtINR, toast } from '../dom.js';
import { findEvent, addContribution, totalFor } from '../events.js';
import { isEventOn } from '../features.js';
import { session } from '../auth.js';
import { navigate } from '../router.js';

export async function render(root, { match }) {
  const evt = findEvent(match.id);
  if (!evt) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Event not found.' })));
  const user = session();
  if (!user) { navigate('/login?next=' + encodeURIComponent(location.hash)); return; }

  const showTiers    = await isEventOn('contribution.suggested', evt);
  const showCustom   = await isEventOn('contribution.custom', evt);
  const allowAnon    = await isEventOn('privacy.anonymous', evt);
  const canHideAmt   = await isEventOn('privacy.amount_hidden', evt);
  const upiOn        = await isEventOn('payment.upi', evt);
  const bankOn       = await isEventOn('payment.bank', evt);

  let amount = evt.fixed_amount || (showTiers && (evt.tiers[0] || {}).amount) || 0;
  const state = { amount, method: upiOn ? 'upi' : bankOn ? 'bank' : 'other', anonymous: false, hide_amount: false, ref: '', remarks: '' };

  const tierGrid = showTiers ? el('div', { class: 'tier-grid' },
    ...evt.tiers.map((t, i) => {
      const b = el('button', { type: 'button', class: 'tier-btn' + (i === 0 ? ' sel' : '') },
        el('div', { class: 'amt', text: fmtINR(t.amount) }),
        el('div', { class: 'hint', text: t.label || (t.highlight ? 'Popular' : '') })
      );
      b.addEventListener('click', () => {
        Array.from(tierGrid.children).forEach(c => c.classList.remove('sel'));
        b.classList.add('sel');
        state.amount = t.amount;
        amtInp.value = String(t.amount);
      });
      return b;
    })
  ) : null;

  const amtInp = el('input', { type: 'number', min: '1', value: String(state.amount) });
  amtInp.addEventListener('input', () => { state.amount = Number(amtInp.value || 0); });

  const methodSel = el('select', {},
    upiOn ? el('option', { value: 'upi', text: 'UPI (scan/pay)' }) : null,
    bankOn ? el('option', { value: 'bank', text: 'Bank transfer (NEFT/IMPS)' }) : null,
    el('option', { value: 'other', text: 'Other / cash (record only)' })
  );
  methodSel.addEventListener('change', () => { state.method = methodSel.value; });

  const anonToggle = el('button', { type: 'button', class: 'toggle', 'aria-label': 'Anonymous' });
  anonToggle.addEventListener('click', () => { state.anonymous = !state.anonymous; anonToggle.classList.toggle('on', state.anonymous); });
  const hideToggle = el('button', { type: 'button', class: 'toggle', 'aria-label': 'Hide amount' });
  hideToggle.addEventListener('click', () => { state.hide_amount = !state.hide_amount; hideToggle.classList.toggle('on', state.hide_amount); });

  const refInp = el('input', { type: 'text', placeholder: 'UPI ref / cheque no. / cash memo' });
  refInp.addEventListener('input', () => { state.ref = refInp.value.trim(); });

  const submitBtn = el('button', { class: 'btn btn-block', on: { click: async () => {
    if (!state.amount || state.amount < 1) return toast('Enter a valid amount', 'err');
    const payload = {
      event: evt.id,
      contributor: user.id, contributor_name: user.name, flat: user.flat,
      amount: state.amount, method: state.method,
      anonymous: state.anonymous, hide_amount: state.hide_amount,
      ref: state.ref, remarks: state.remarks,
    };
    const rec = addContribution(payload, user);
    toast('Contribution recorded · pending verification', 'ok');
    navigate('/e/' + evt.id);
  } } }, 'Continue');

  const form = el('div', { class: 'card card-pad' },
    el('h2', { text: 'Contribute · ' + evt.title }),
    el('p', { class: 'sub', text: 'Every rupee goes to the committee. Receipt is minted after Management Committee verifies.' }),
    showTiers ? el('div', { class: 'field' }, el('label', { text: 'Choose an amount' }), tierGrid) : null,
    (showCustom || !showTiers) ? el('div', { class: 'field' }, el('label', { for: 'amt', text: 'Amount (₹)' }), amtInp) : null,
    el('div', { class: 'field' }, el('label', { text: 'Payment method' }), methodSel),
    el('div', { class: 'field' }, el('label', { text: 'Reference / cheque no. (optional)' }), refInp),
    allowAnon ? el('div', { class: 'callout', style: 'margin:14px 0' },
      el('div', {},
        el('div', { class: 'lbl', text: 'Contribute anonymously' }),
        el('small', { text: 'Your name will not appear on the public board. Committee still keeps records for reconciliation.' })
      ),
      anonToggle
    ) : null,
    canHideAmt ? el('div', { class: 'callout callout-muted', style: 'margin:6px 0 14px;background:#efe4d0;color:var(--muted);border-color:#efe4d0' },
      el('div', {},
        el('div', { class: 'lbl', text: 'Hide amount on public board' }),
        el('small', { text: 'Show your name (or Anonymous) without the ₹ amount.' })
      ),
      hideToggle
    ) : null,
    submitBtn,
    el('div', { style: 'text-align:center;margin-top:10px' }, el('small', { text: 'UPI · NEFT · Cash · Cheque — all methods accepted, ledger stays single-source.' }))
  );

  mount(root, form);
}
