/* Contribute view — resident-facing contribution flow.
 *
 * Two-step trust model (mirrors ta-society-helpdesk):
 *   1. Contributor pays via one of the society's CONFIGURED methods
 *      (UPI VPA / bank details from config/society.json → payment.*),
 *      or records that they paid by cash / cheque.
 *   2. They enter the txn ref (UTR / cheque no.) AND optionally attach
 *      a screenshot of the payment. The record is stored as `pending`.
 *   3. A committee member opens Event → Manage, checks the ref/proof,
 *      and clicks Verify. Only THEN is a receipt minted, made visible
 *      to the contributor for download, and queued for the private
 *      archive repo (see receipts.js + archive.js).
 *
 * The receipt route (#/receipt/<contribId>) refuses to render if
 * `status !== 'verified'`, so this is enforced at the view layer too.
 *
 * Honours event feature flags: shows tiers only if
 * contribution.suggested is on, shows anonymous toggle only if
 * privacy.anonymous is on, etc.
 */
'use strict';
import { el, mount, fmtINR, toast } from '../dom.js';
import { findEvent, addContribution } from '../events.js';
import { isEventOn } from '../features.js';
import { session } from '../auth.js';
import { navigate } from '../router.js';
import { getSociety } from '../store.js';

/* Client-side image compression so payment screenshots don't blow the
 * ~5 MB localStorage quota. Non-images (PDFs) are passed through as
 * base64 with a hard 750 KB cap. */
const MAX_DIM = 1400;                // px
const MAX_BYTES_IMG = 500 * 1024;    // 500 KB after re-encode
const MAX_BYTES_RAW = 750 * 1024;    // 750 KB for PDFs and non-images

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('read failed'));
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}
async function shrinkImageIfNeeded(file) {
  if (!/^image\//.test(file.type)) {
    if (file.size > MAX_BYTES_RAW) throw new Error('File too large - keep under 750 KB.');
    return await fileToDataUrl(file);
  }
  const raw = await fileToDataUrl(file);
  const img = new Image();
  await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('image decode failed')); img.src = raw; });
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  /* Try successively lower JPEG qualities until we fit. */
  for (const q of [0.85, 0.72, 0.6, 0.5, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length * 0.75 <= MAX_BYTES_IMG) return url;
  }
  return canvas.toDataURL('image/jpeg', 0.35);
}

/* Build a UPI intent URL per the NPCI spec - mobile apps deep-link
 * into this automatically. If the amount is 0 the app just opens the
 * payee screen with the VPA prefilled. */
function upiIntentUrl({ vpa, name, amount, note }) {
  if (!vpa) return '';
  const p = new URLSearchParams();
  p.set('pa', vpa);
  if (name)   p.set('pn', name);
  if (amount) p.set('am', String(amount));
  p.set('cu', 'INR');
  if (note)   p.set('tn', note);
  return 'upi://pay?' + p.toString();
}

export async function render(root, { match }) {
  const evt = findEvent(match.id);
  if (!evt) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Event not found.' })));
  const user = session();
  if (!user) { navigate('/login?next=' + encodeURIComponent(location.hash)); return; }
  /* Contributions can only be added while the event is PUBLISHED.
   * Draft / review = not visible to the public yet; closed / archived
   * = no longer accepting money. Committee members hitting this URL
   * on a draft get a clear "not yet" card instead of a broken form. */
  if (evt.status !== 'published') {
    const msgByStatus = {
      draft:    'This event is still a draft. It will accept contributions once the committee publishes it.',
      review:   'This event is in review. It will accept contributions once it is published.',
      closed:   'This event is closed. Contributions are no longer being accepted.',
      archived: 'This event has been archived.',
    };
    return mount(root,
      el('div', { class: 'card card-pad' },
        el('h2', { text: 'Not accepting contributions yet' }),
        el('p', { class: 'sub', text: msgByStatus[evt.status] || 'Contributions are not enabled for this event.' }),
        el('div', { class: 'row', style: 'gap:8px;margin-top:12px' },
          el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}` }, 'Back to event'),
          el('a', { class: 'btn', href: '#/events' }, 'Browse events')
        )
      )
    );
  }

  const showTiers    = await isEventOn('contribution.suggested', evt);
  const showCustom   = await isEventOn('contribution.custom', evt);
  const allowAnon    = await isEventOn('privacy.anonymous', evt);
  const canHideAmt   = await isEventOn('privacy.amount_hidden', evt);
  const upiOn        = await isEventOn('payment.upi', evt);
  const bankOn       = await isEventOn('payment.bank', evt);
  const soc          = await getSociety();
  const pay          = (soc && soc.payment) || {};
  const bank         = pay.bank || {};

  let amount = evt.fixed_amount || (showTiers && (evt.tiers[0] || {}).amount) || 0;
  const st = {
    amount, method: upiOn ? 'upi' : bankOn ? 'bank' : 'other',
    anonymous: false, hide_amount: false, ref: '', remarks: '',
    proof_data_url: '', proof_name: '', proof_size: 0
  };

  const tierGrid = showTiers ? el('div', { class: 'tier-grid' },
    ...evt.tiers.map((t, i) => {
      const b = el('button', { type: 'button', class: 'tier-btn' + (i === 0 ? ' sel' : '') },
        el('div', { class: 'amt', text: fmtINR(t.amount) }),
        el('div', { class: 'hint', text: t.label || (t.highlight ? 'Popular' : '') })
      );
      b.addEventListener('click', () => {
        Array.from(tierGrid.children).forEach(c => c.classList.remove('sel'));
        b.classList.add('sel');
        st.amount = t.amount;
        amtInp.value = String(t.amount);
        refreshPayHint();
      });
      return b;
    })
  ) : null;

  const amtInp = el('input', { type: 'number', min: '1', value: String(st.amount) });
  amtInp.addEventListener('input', () => { st.amount = Number(amtInp.value || 0); refreshPayHint(); });

  const methodSel = el('select', {},
    upiOn ? el('option', { value: 'upi', text: 'UPI (scan / pay)' }) : null,
    bankOn ? el('option', { value: 'bank', text: 'Bank transfer (NEFT / IMPS)' }) : null,
    el('option', { value: 'other', text: 'Cash / cheque (record only)' })
  );
  methodSel.addEventListener('change', () => { st.method = methodSel.value; refreshPayHint(); refreshRefLabel(); });

  const anonToggle = el('button', { type: 'button', class: 'toggle', 'aria-label': 'Anonymous' });
  anonToggle.addEventListener('click', () => { st.anonymous = !st.anonymous; anonToggle.classList.toggle('on', st.anonymous); });
  const hideToggle = el('button', { type: 'button', class: 'toggle', 'aria-label': 'Hide amount' });
  hideToggle.addEventListener('click', () => { st.hide_amount = !st.hide_amount; hideToggle.classList.toggle('on', st.hide_amount); });

  const refLabel = el('label', { text: 'UPI reference / UTR' });
  const refInp = el('input', { type: 'text', placeholder: '12-digit UPI reference' });
  refInp.addEventListener('input', () => { st.ref = refInp.value.trim(); });
  function refreshRefLabel() {
    if (st.method === 'upi')        { refLabel.textContent = 'UPI reference / UTR';       refInp.placeholder = '12-digit UPI reference'; }
    else if (st.method === 'bank')  { refLabel.textContent = 'NEFT / IMPS reference';     refInp.placeholder = 'Bank txn reference'; }
    else                            { refLabel.textContent = 'Cheque no. / cash memo';    refInp.placeholder = 'Cheque no. or cash memo'; }
  }

  /* ---------- Payment guide (populated from society.payment) ---------- */
  const row2 = (k, v) => el('div', { style: 'display:grid;grid-template-columns:120px 1fr;gap:6px;padding:2px 0' },
    el('small', { style: 'color:var(--muted)', text: k }),
    el('div', { style: 'font-family:ui-monospace,monospace;font-size:14px', text: v })
  );
  const payHint = el('div', { class: 'callout', style: 'margin:14px 0;flex-direction:column;align-items:stretch;gap:10px' });
  function refreshPayHint() {
    payHint.textContent = '';
    if (st.method === 'upi' && upiOn) {
      if (!pay.upi_vpa) {
        payHint.append(el('small', { text: 'The committee has not published a UPI ID yet. Please choose Bank or Cash, or ask an admin to add a UPI VPA in Society settings.' }));
        return;
      }
      const intent = upiIntentUrl({ vpa: pay.upi_vpa, name: pay.upi_name || soc.short_name, amount: st.amount, note: `Contribution: ${evt.title}` });
      payHint.append(
        el('div', { class: 'lbl', text: 'Pay via UPI' }),
        el('div', { class: 'row', style: 'gap:16px;flex-wrap:wrap;align-items:center' },
          el('div', {},
            el('div', { style: 'font-weight:700', text: pay.upi_name || soc.short_name }),
            el('div', { style: 'font-family:ui-monospace,monospace;font-size:14px', text: pay.upi_vpa })
          ),
          intent ? el('a', { class: 'btn btn-sm', href: intent }, '📱 Open UPI app') : null
        ),
        el('small', { text: 'On desktop, use the VPA above in your bank app. On mobile, tap "Open UPI app" and confirm the amount inside the app.' })
      );
    } else if (st.method === 'bank' && bankOn) {
      if (!bank.account) {
        payHint.append(el('small', { text: 'The committee has not published bank details yet. Please choose UPI or Cash, or ask an admin to add bank details in Society settings.' }));
        return;
      }
      payHint.append(
        el('div', { class: 'lbl', text: 'Pay via NEFT / IMPS' }),
        el('div', {},
          bank.holder  ? row2('Beneficiary', bank.holder)  : null,
          bank.account ? row2('Account no.', bank.account) : null,
          bank.ifsc    ? row2('IFSC',        bank.ifsc)    : null,
          bank.branch  ? row2('Branch',      bank.branch)  : null,
        ),
        el('small', { text: 'After the transfer, note the UTR from your bank app and paste it below.' })
      );
    } else {
      payHint.append(
        el('div', { class: 'lbl', text: 'Cash / cheque' }),
        el('small', { text: 'Hand the cash / cheque to a committee member and enter the receipt number they give you below. The committee will verify on their side.' })
      );
    }
  }

  /* ---------- Payment proof upload ---------- */
  const proofInp = el('input', { type: 'file', accept: 'image/*,application/pdf' });
  const proofStatus = el('small', { class: 'sub', text: 'Optional but recommended: a screenshot or PDF of the payment confirmation. Speeds up verification.' });
  const proofPreview = el('div', {});
  proofInp.addEventListener('change', async () => {
    const f = proofInp.files && proofInp.files[0];
    if (!f) { st.proof_data_url = ''; st.proof_name = ''; st.proof_size = 0; proofPreview.textContent = ''; proofStatus.textContent = 'No file attached.'; return; }
    proofStatus.textContent = 'Compressing…';
    try {
      const url = await shrinkImageIfNeeded(f);
      st.proof_data_url = url;
      st.proof_name = f.name;
      st.proof_size = Math.round(url.length * 0.75);
      proofStatus.textContent = `Attached: ${f.name} · ~${Math.round(st.proof_size / 1024)} KB`;
      proofPreview.textContent = '';
      if (/^data:image\//.test(url)) {
        proofPreview.append(el('img', { src: url, alt: 'payment proof', style: 'max-width:100%;max-height:220px;margin-top:8px;border:1px solid var(--line);border-radius:6px' }));
      } else {
        proofPreview.append(el('div', { style: 'margin-top:8px;padding:8px;border:1px dashed var(--line);border-radius:6px', text: `PDF · ${f.name}` }));
      }
    } catch (e) {
      st.proof_data_url = ''; st.proof_name = ''; st.proof_size = 0;
      proofPreview.textContent = '';
      proofStatus.textContent = e.message || 'Could not attach that file.';
      toast(e.message || 'Attach failed', 'err');
    }
  });

  const submitBtn = el('button', { class: 'btn btn-block', on: { click: async () => {
    if (!st.amount || st.amount < 1) return toast('Enter a valid amount', 'err');
    if ((st.method === 'upi' || st.method === 'bank') && !st.ref && !st.proof_data_url) {
      return toast('Please enter the payment reference OR attach a screenshot so we can verify.', 'err');
    }
    const payload = {
      event: evt.id,
      contributor: user.id, contributor_name: user.name, flat: user.flat,
      amount: st.amount, method: st.method,
      anonymous: st.anonymous, hide_amount: st.hide_amount,
      ref: st.ref, remarks: st.remarks,
      proof_data_url: st.proof_data_url,
      proof_name: st.proof_name,
      proof_size: st.proof_size,
    };
    addContribution(payload, user);
    toast('Submitted · awaiting committee verification', 'ok');
    navigate('/e/' + evt.id);
  } } }, 'Submit for verification');

  const form = el('div', { class: 'card card-pad' },
    el('h2', { text: 'Contribute · ' + evt.title }),
    el('p', { class: 'sub', text: 'Every rupee goes to the committee. The receipt is minted and made available for download only after the Management Committee verifies your payment.' }),
    showTiers ? el('div', { class: 'field' }, el('label', { text: 'Choose an amount' }), tierGrid) : null,
    (showCustom || !showTiers) ? el('div', { class: 'field' }, el('label', { for: 'amt', text: 'Amount (₹)' }), amtInp) : null,
    el('div', { class: 'field' }, el('label', { text: 'Payment method' }), methodSel),
    payHint,
    el('div', { class: 'field' }, refLabel, refInp),
    el('div', { class: 'field' },
      el('label', { text: 'Payment proof (screenshot / PDF)' }),
      proofInp,
      proofStatus,
      proofPreview
    ),
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
    el('div', { style: 'text-align:center;margin-top:10px' }, el('small', { text: 'UPI · NEFT · Cash · Cheque - all methods accepted, ledger stays single-source.' }))
  );

  refreshRefLabel();
  refreshPayHint();
  mount(root, form);
}
