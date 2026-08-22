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
import { findEvent, addContribution, contribsFor } from '../events.js';
import { isEventOn } from '../features.js';
import { session } from '../auth.js';
import { navigate } from '../router.js';
import { getSociety, state } from '../store.js';
import { emit as notifyEmit } from '../notify.js';
import { parseFlat, validateMobile, flatRuleText } from '../validators.js';

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
  /* Privacy defaults for a fresh contribute form. Admin can flip either
   * default on via Settings → Attributes → Contribution privacy so a
   * community that prefers anonymity gets that as the starting state. */
  const privDefaults = (soc && soc.contributions) || {};
  const st = {
    amount, method: upiOn ? 'upi' : bankOn ? 'bank' : 'other',
    anonymous: allowAnon && !!privDefaults.default_anonymous,
    hide_amount: canHideAmt && !!privDefaults.default_hide_amount,
    ref: '', remarks: '',
    proof_data_url: '', proof_name: '', proof_size: 0,
    /* Contributor details — required on every submit. Prefilled from the
     * signed-in user profile; editable so residents can correct a
     * missing flat or type-o. When on_behalf is true, these fields hold
     * the BENEFICIARY's info and the signed-in user's info is captured
     * separately as `filled_by_*`. Mobile is mandatory too so the
     * committee can call the payer if a receipt needs rectification. */
    contributor_name: user.name || '',
    contributor_email: user.email || '',
    contributor_flat: user.flat || '',
    contributor_mobile: user.mobile || '',
    on_behalf: false,
  };
  const draft = state.contribDraft(evt.id);
  if (draft && typeof draft === 'object') {
    if (Number(draft.amount || 0) > 0) st.amount = Number(draft.amount);
    if (draft.method) st.method = String(draft.method);
    if (typeof draft.anonymous === 'boolean') st.anonymous = draft.anonymous;
    if (typeof draft.hide_amount === 'boolean') st.hide_amount = draft.hide_amount;
    if (draft.ref) st.ref = String(draft.ref);
    if (draft.remarks) st.remarks = String(draft.remarks);
    if (draft.contributor_name) st.contributor_name = String(draft.contributor_name);
    if (draft.contributor_email) st.contributor_email = String(draft.contributor_email);
    if (draft.contributor_flat) st.contributor_flat = String(draft.contributor_flat);
    if (draft.contributor_mobile) st.contributor_mobile = String(draft.contributor_mobile);
    if (typeof draft.on_behalf === 'boolean') st.on_behalf = draft.on_behalf;
  }

  function persistDraft() {
    state.saveContribDraft(evt.id, {
      amount: st.amount,
      method: st.method,
      anonymous: st.anonymous,
      hide_amount: st.hide_amount,
      ref: st.ref,
      remarks: st.remarks,
      contributor_name: st.contributor_name,
      contributor_email: st.contributor_email,
      contributor_flat: st.contributor_flat,
      contributor_mobile: st.contributor_mobile,
      on_behalf: st.on_behalf,
    });
  }

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
        persistDraft();
      });
      return b;
    })
  ) : null;

  const amtInp = el('input', { type: 'number', min: '1', value: String(st.amount) });
  amtInp.addEventListener('input', () => { st.amount = Number(amtInp.value || 0); refreshPayHint(); persistDraft(); });

  const methodSel = el('select', {},
    upiOn ? el('option', { value: 'upi', text: 'UPI (scan / pay)' }) : null,
    bankOn ? el('option', { value: 'bank', text: 'Bank transfer (NEFT / IMPS)' }) : null,
    el('option', { value: 'other', text: 'Cash / cheque (record only)' })
  );
  methodSel.value = st.method;
  methodSel.addEventListener('change', () => { st.method = methodSel.value; refreshPayHint(); refreshRefLabel(); persistDraft(); });

  const anonToggle = el('button', { type: 'button', class: 'toggle' + (st.anonymous ? ' on' : ''), 'aria-label': 'Anonymous' });
  anonToggle.addEventListener('click', () => { st.anonymous = !st.anonymous; anonToggle.classList.toggle('on', st.anonymous); persistDraft(); });
  const hideToggle = el('button', { type: 'button', class: 'toggle' + (st.hide_amount ? ' on' : ''), 'aria-label': 'Hide amount' });
  hideToggle.addEventListener('click', () => { st.hide_amount = !st.hide_amount; hideToggle.classList.toggle('on', st.hide_amount); persistDraft(); });

  const refLabel = el('label', { text: 'UPI reference / UTR' });
  const refInp = el('input', { type: 'text', placeholder: '12-digit UPI reference', value: st.ref || '' });
  refInp.addEventListener('input', () => { st.ref = refInp.value.trim(); persistDraft(); });
  const noteInp = el('textarea', {
    rows: 3,
    placeholder: 'Optional: if you cannot update contribution details yourself, leave a note for committee follow-up.',
    value: st.remarks || ''
  });
  noteInp.addEventListener('input', () => { st.remarks = noteInp.value.trim(); persistDraft(); });
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
  /* Event-level payment override: if the event creator set a per-event
   * UPI VPA and/or a QR image, prefer those over the society-wide
   * defaults. Rationale: some events (e.g. a specific sponsor drive)
   * flow to a dedicated collection account rather than the main
   * society VPA. Both are validated at event-save time; here we just
   * fall back to society-level if the event fields are blank. */
  const evtVpa = (evt.payment_upi_vpa || '').trim();
  const evtVpaName = (evt.payment_upi_name || '').trim();
  const evtQr = (evt.payment_qr_data_url || '').trim();
  const effVpa  = evtVpa  || pay.upi_vpa || '';
  const effVpaName = evtVpaName || pay.upi_name || soc.short_name;
  /* QR fallback chain: per-event data-URL (evt.payment_qr_data_url) →
   * society default asset (society.payment.qr_asset_url from Settings).
   * Both are optional; if neither exists the UPI hint just skips the
   * QR image and shows the copy-VPA button only. */
  const effQr = evtQr || (pay.qr_asset_url || '').trim();
  function refreshPayHint() {
    payHint.textContent = '';
    if (st.method === 'upi' && upiOn) {
      if (!effVpa && !effQr) {
        payHint.append(el('small', { text: 'The committee has not published a UPI ID or QR for this event yet. Please choose Bank or Cash, or ask an admin to add UPI details in event settings.' }));
        return;
      }
      /* Build the UPI intent URL via URLSearchParams (see upiIntentUrl).
       * The `href` scheme is hardcoded to `upi://pay?` so a malformed
       * VPA cannot smuggle in a different protocol. The anchor uses
       * `rel="noopener noreferrer"` even though upi:// hands off to the
       * OS handler — defense in depth against any future rewrites.
       *
       * ** UPI safety notes ** — We deliberately DO NOT use app-specific
       * schemes (`tez://`, `phonepe://pay`, `paytmmp://pay`) because:
       *   1. Those schemes are undocumented and change silently between
       *      app versions — a broken deep-link silently fails and the
       *      resident thinks WE lost their payment.
       *   2. Probing them from JS leaks which UPI apps the user has
       *      installed, a fingerprinting vector.
       *   3. The generic `upi://pay?...` intent is the NPCI-standard
       *      hand-off; Android's Intent chooser natively lists every
       *      installed UPI app (GPay, PhonePe, Paytm, BHIM, Amazon Pay,
       *      WhatsApp Pay, Cred, bank-branded UPI apps, …) and the
       *      resident picks the one they trust. */
      const intent = effVpa ? upiIntentUrl({ vpa: effVpa, name: effVpaName, amount: st.amount, note: `Contribution: ${evt.title}` }) : '';
      const copyBtn = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Copy UPI ID' }, '📋 Copy UPI ID');
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(effVpa);
          toast('UPI ID copied — paste it in your bank / UPI app', 'ok');
        } catch (_e) {
          /* Older browsers / insecure contexts: fall back to
           * selecting a hidden textarea so the resident can still
           * copy manually. */
          const ta = document.createElement('textarea');
          ta.value = effVpa; ta.style.position = 'fixed'; ta.style.top = '-100px';
          document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); toast('UPI ID copied', 'ok'); }
          catch (_e2) { toast('Copy failed — long-press the UPI ID above to copy it', 'err'); }
          ta.remove();
        }
      });
      payHint.append(
        ...[
          el('div', { class: 'lbl', text: 'Pay via UPI' }),
          effVpa ? el('div', { class: 'tvh-upi-payee' },
            el('div', { class: 'tvh-upi-payee-name', text: effVpaName }),
            el('div', { class: 'tvh-upi-payee-vpa', text: effVpa }),
          ) : null,
          intent ? el('a', {
            class: 'btn btn-block tvh-upi-cta',
            href: intent,
            rel: 'noopener noreferrer',
            'aria-label': `Pay ${fmtINR(st.amount)} via UPI`,
          },
            el('span', { class: 'tvh-upi-cta-ico', text: '📱' }),
            el('span', { class: 'tvh-upi-cta-txt' },
              el('span', { class: 'tvh-upi-cta-lead', text: `Pay ${fmtINR(st.amount)}` }),
              el('span', { class: 'tvh-upi-cta-sub', text: 'via any UPI app' }),
            ),
            el('span', { class: 'tvh-upi-cta-caret', 'aria-hidden': 'true', text: '›' })
          ) : null,
          effVpa ? el('div', { class: 'row tvh-upi-actions', style: 'gap:8px;flex-wrap:wrap;margin-top:8px' }, copyBtn) : null,
          /* Compatibility strip: reassures residents that the single
           * "Pay via UPI" button will work with whichever app they
           * prefer. Purely informational — no app-specific hooks. */
          el('div', { class: 'tvh-upi-apps' },
            el('span', { class: 'tvh-upi-apps-lbl', text: 'Opens any installed UPI app:' }),
            el('span', { class: 'tvh-upi-apps-list', text: 'GPay · PhonePe · Paytm · BHIM · Amazon Pay · WhatsApp Pay · CRED · bank UPI apps' })
          ),
          evtQr ? el('div', { class: 'tvh-upi-qr' },
            el('small', { class: 'sub', text: 'Or scan the QR code below with any UPI app:' }),
            /* QR data URL is validated at event-save time (PNG/JPEG/WebP
             * only, size-capped, SVG explicitly rejected). Safe to
             * render as a data-URL <img>. */
            el('img', { src: evtQr, alt: 'Scan to pay via UPI', style: 'display:block;max-width:220px;margin:8px auto 0;border:1px solid var(--line);border-radius:8px;background:#fff;padding:6px' })
          ) : (effQr ? el('div', { class: 'tvh-upi-qr' },
            el('small', { class: 'sub', text: 'Or scan the society QR below with any UPI app:' }),
            /* Society-level QR image path (society.payment.qr_asset_url).
             * Same-origin asset only — no data-URL, no cross-origin URL
             * — so browser cache + CSP img-src 'self' both hold. */
            el('img', { src: effQr, alt: 'Scan to pay via UPI', style: 'display:block;max-width:220px;margin:8px auto 0;border:1px solid var(--line);border-radius:8px;background:#fff;padding:6px' })
          ) : null),
          el('small', { style: 'display:block;margin-top:8px', text: 'On desktop, use the UPI ID above in your bank app. On mobile, tap "Pay" or scan the QR and confirm the amount inside the app.' })
        ].filter(Boolean)
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

  /* ---------- Payment proof upload ----------
   * Proof pairs with the UPI/UTR reference under a shared "Payment
   * verification (any one)" group — either the reference OR the proof
   * satisfies the requirement, so we do NOT mark the proof label with
   * a standalone `*`. The `*` sits on the group heading so residents
   * see "one of the two is required" without thinking both are. */
  const proofInp = el('input', { type: 'file', accept: 'image/*,application/pdf' });
  const proofStatus = el('small', { class: 'sub', text: 'Attach a screenshot or PDF of the payment confirmation — used by the committee to verify.' });
  const proofPreview = el('div', {});
  const proofLabel = el('label', { text: 'Payment proof (screenshot / PDF)' });
  function refreshProofLabel() {
    if (st.proof_data_url) {
      proofStatus.textContent = `Attached: ${st.proof_name} · ~${Math.round(st.proof_size / 1024)} KB`;
    } else {
      proofStatus.textContent = 'Attach a screenshot or PDF of the payment confirmation — used by the committee to verify.';
    }
  }
  proofInp.addEventListener('change', async () => {
    const f = proofInp.files && proofInp.files[0];
    if (!f) { st.proof_data_url = ''; st.proof_name = ''; st.proof_size = 0; proofPreview.textContent = ''; refreshProofLabel(); return; }
    proofStatus.textContent = 'Compressing…';
    try {
      const url = await shrinkImageIfNeeded(f);
      st.proof_data_url = url;
      st.proof_name = f.name;
      st.proof_size = Math.round(url.length * 0.75);
      refreshProofLabel();
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

  /* ---------- Contributor identity block ----------
   * Name / email / flat are mandatory. Prefilled from the signed-in
   * user profile. When "on behalf" is ticked, these fields become the
   * BENEFICIARY's info and a read-only "Filled by (you)" chip
   * captures the signed-in user's identity. Both parties are notified
   * on submit AND on committee verification. The payment-verification
   * rule (UPI reference OR proof) is the SAME for self and on-behalf
   * submissions — no separate stricter rule for on-behalf. */
  const reqLbl = (text) => el('label', {},
    el('span', { text }),
    el('span', { class: 'req', 'aria-hidden': 'true', text: '*' })
  );

  const nameInp  = el('input', { type: 'text',  autocomplete: 'name',       required: '',
    'aria-required': 'true', value: st.contributor_name });
  const emailInp = el('input', { type: 'email', autocomplete: 'email',      required: '',
    'aria-required': 'true', value: st.contributor_email });
  /* Flat number follows the society's tower/floor/slot scheme
   * (see validators.js#parseFlat). Pattern hint helps mobile Safari
   * show the alphanumeric keyboard while `pattern` triggers the
   * native invalid tooltip if the user submits garbage.
   * NOTE: HTML5 pattern is compiled with the `v` flag in modern
   * browsers, which forbids an unescaped `-` inside a character
   * class. Keeping the hyphen OUTSIDE the class avoids the
   * "Invalid character in character class" console warning. */
  const flatInp  = el('input', { type: 'text',  autocomplete: 'address-line2', required: '',
    'aria-required': 'true', placeholder: 'e.g. A-101 or B-1305',
    pattern: '[A-Ca-c]-?\\d{3,4}',
    value: st.contributor_flat });
  /* Mobile is a 10-digit Indian number (starting 6-9). Committee uses
   * it only if a receipt needs rectification (wrong flat, wrong name,
   * spelling). It is NEVER shown on the public board. `inputmode` +
   * `pattern` help the mobile browser open the numeric keypad. */
  const mobileInp = el('input', { type: 'tel', autocomplete: 'tel-national', required: '',
    'aria-required': 'true', inputmode: 'numeric', maxlength: '10',
    pattern: '[6-9][0-9]{9}', placeholder: '10-digit mobile number', value: st.contributor_mobile });
  nameInp .addEventListener('input', () => { st.contributor_name  = nameInp.value.trim(); persistDraft(); });
  emailInp.addEventListener('input', () => { st.contributor_email = emailInp.value.trim(); persistDraft(); });
  flatInp .addEventListener('input', () => { st.contributor_flat  = flatInp.value.trim(); persistDraft(); });
  /* Blur-time canonicalisation: whatever the resident typed
   * ("a101", "A 101", "a-1301") gets rewritten to the canonical
   * `TOWER-FloorSlot` form the moment they leave the field. If the
   * input is invalid we leave it alone (so a validation toast on
   * submit points at their actual text) but never eagerly toast on
   * blur — that's annoying while typing. */
  flatInp.addEventListener('blur', () => {
    const parsed = parseFlat(flatInp.value);
    if (parsed.valid && parsed.canonical !== flatInp.value) {
      flatInp.value = parsed.canonical;
      st.contributor_flat = parsed.canonical;
      persistDraft();
    }
  });
  mobileInp.addEventListener('input', () => {
    /* Strip everything that isn't a digit so users can paste "+91 98
     * 1234 5678" and the field still ends up with the plain 10 digits. */
    const digits = (mobileInp.value || '').replace(/\D+/g, '').replace(/^91(?=\d{10}$)/, '');
    if (digits !== mobileInp.value) mobileInp.value = digits;
    st.contributor_mobile = digits;
    persistDraft();
  });

  const identityHead = el('div', { class: 'lbl', style: 'font-weight:800;font-size:14px;margin:4px 0 10px', text: 'Contributor details' });
  const identitySub  = el('small', { class: 'sub', style: 'display:block;margin-bottom:10px', text: 'Prefilled from your profile — edit if anything is out of date.' });

  const behalfChk = el('input', { type: 'checkbox', checked: !!st.on_behalf });
  const behalfRow = el('label', { class: 'check-row', style: 'margin-top:6px' },
    behalfChk,
    el('span', { text: 'I am filling this on behalf of someone else' })
  );
  const filledByChip = el('div', { class: 'callout callout-muted', style: 'margin:8px 0 12px;background:#efe4d0;color:var(--muted);border-color:#efe4d0;flex-direction:column;align-items:stretch;gap:2px', hidden: true },
    el('div', { class: 'lbl', text: 'Filled by (you)' }),
    el('small', { text: `${user.name || 'You'} · ${user.email || ''}${user.flat ? ' · Flat ' + user.flat : ''}` })
  );

  const nameField  = el('div', { class: 'field' }, reqLbl('Name'),         nameInp);
  const emailField = el('div', { class: 'field' }, reqLbl('Email'),        emailInp);
  const mobileField = el('div', { class: 'field' }, reqLbl('Mobile number'), mobileInp,
    el('small', { class: 'sub', text: 'Used only if the committee needs to reach you to rectify a receipt. Not shown publicly.' })
  );
  const flatField  = el('div', { class: 'field' }, reqLbl('Flat number'),  flatInp,
    el('small', { class: 'sub', text: flatRuleText() })
  );

  function refreshIdentityLabels() {
    const isBehalf = st.on_behalf;
    filledByChip.hidden = !isBehalf;
    nameField.querySelector('label span:first-child').textContent  = isBehalf ? 'Beneficiary name'        : 'Name';
    emailField.querySelector('label span:first-child').textContent = isBehalf ? 'Beneficiary email'       : 'Email';
    mobileField.querySelector('label span:first-child').textContent = isBehalf ? 'Beneficiary mobile number' : 'Mobile number';
    flatField.querySelector('label span:first-child').textContent  = isBehalf ? 'Beneficiary flat number' : 'Flat number';
    /* Reset autofilled values only when TOGGLING on/off with untouched
     * fields matching the previous mode's defaults, so residents don't
     * lose typed data. */
    if (isBehalf) {
      if (nameInp.value  === (user.name  || '')) { nameInp.value  = ''; st.contributor_name  = ''; }
      if (emailInp.value === (user.email || '')) { emailInp.value = ''; st.contributor_email = ''; }
      if (mobileInp.value === (user.mobile || '')) { mobileInp.value = ''; st.contributor_mobile = ''; }
      if (flatInp.value  === (user.flat  || '')) { flatInp.value  = ''; st.contributor_flat  = ''; }
    } else {
      if (!nameInp.value)   { nameInp.value  = user.name  || ''; st.contributor_name  = user.name  || ''; }
      if (!emailInp.value)  { emailInp.value = user.email || ''; st.contributor_email = user.email || ''; }
      if (!mobileInp.value) { mobileInp.value = user.mobile || ''; st.contributor_mobile = user.mobile || ''; }
      if (!flatInp.value)   { flatInp.value  = user.flat  || ''; st.contributor_flat  = user.flat  || ''; }
    }
    refreshProofLabel();
  }
  behalfChk.addEventListener('change', () => { st.on_behalf = behalfChk.checked; refreshIdentityLabels(); persistDraft(); });

  const submitBtn = el('button', { class: 'btn btn-block', on: { click: async () => {
    if (!st.amount || st.amount < 1) return toast('Enter a valid amount', 'err');
    if (!st.contributor_name)  return toast('Name is required', 'err');
    if (!st.contributor_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(st.contributor_email)) {
      return toast('Enter a valid email address', 'err');
    }
    /* Mobile: strict 10-digit / 6-9 start / defensive strip of +91
     * & leading 0 via the shared validator. */
    const mobCheck = validateMobile(st.contributor_mobile);
    if (!mobCheck.valid) return toast(mobCheck.reason, 'err');
    st.contributor_mobile = mobCheck.digits;
    if (mobileInp.value !== mobCheck.digits) mobileInp.value = mobCheck.digits;
    /* Flat: canonical `Tower-FloorSlot`. Rejects made-up towers, floors
     * above 13, and slots beyond the per-tower cap (A/C:4, B:6). */
    if (!st.contributor_flat) return toast('Flat number is required', 'err');
    const flatCheck = parseFlat(st.contributor_flat);
    if (!flatCheck.valid) return toast(flatCheck.reason, 'err');
    st.contributor_flat = flatCheck.canonical;
    if (flatInp.value !== flatCheck.canonical) flatInp.value = flatCheck.canonical;
    /* Enforce the event's "one contribution per flat" rule client-side
     * with a friendly message. `addContribution` also enforces the
     * same rule at storage time so a devtools-crafted submit can't
     * bypass it (defense in depth). Match is case-insensitive on flat
     * OR by signed-in contributor id (covers the case where a resident
     * changes flat text between attempts). */
    if (evt.one_per_flat) {
      const flatKey = st.contributor_flat.trim().toLowerCase();
      const cid = st.on_behalf ? null : user.id;
      const dup = contribsFor(evt.id).find(c => c.status !== 'void' && (
        (flatKey && String(c.flat || '').trim().toLowerCase() === flatKey) ||
        (cid     && c.contributor === cid)
      ));
      if (dup) {
        return toast('This event accepts only ONE contribution per flat. A submission from your flat already exists.', 'err');
      }
    }
    /* Payment verification rule (same for self AND on-behalf):
     *   UPI  → UPI reference (UTR)  OR  payment proof screenshot
     *   Bank → NEFT/IMPS reference  OR  payment proof screenshot
     *   Cash → cheque no. / cash memo goes in the ref field; proof
     *          optional (kept flexible for events where the committee
     *          collects at a desk and writes a memo). */
    if ((st.method === 'upi' || st.method === 'bank') && !st.ref && !st.proof_data_url) {
      return toast('Enter the payment reference OR attach a transaction receipt — one of the two is required.', 'err');
    }
    /* Contributor / beneficiary payload. When on_behalf is true the
     * `contributor` id is left blank (the beneficiary may not have an
     * account yet) and their email is captured on `contributor_email`
     * for downstream notifications and receipt delivery. */
    const payload = {
      event: evt.id,
      contributor: st.on_behalf ? '' : user.id,
      contributor_name: st.contributor_name,
      contributor_email: st.contributor_email,
      contributor_mobile: st.contributor_mobile,
      flat: st.contributor_flat,
      amount: st.amount, method: st.method,
      anonymous: st.anonymous, hide_amount: st.hide_amount,
      ref: st.ref, remarks: st.remarks,
      proof_data_url: st.proof_data_url,
      proof_name: st.proof_name,
      proof_size: st.proof_size,
      on_behalf: st.on_behalf,
      filled_by_id:    st.on_behalf ? user.id    : null,
      filled_by_name:  st.on_behalf ? user.name  : null,
      filled_by_email: st.on_behalf ? user.email : null,
    };
    let rec;
    try {
      rec = addContribution(payload, user);
    } catch (e) {
      /* addContribution enforces the one-per-flat rule at storage
       * time. Surface its message as a friendly toast rather than a
       * console crash. */
      return toast(e.message || 'Could not submit contribution', 'err');
    }
    /* Notify both parties when on_behalf; otherwise notify just the
     * contributor. Best-effort — failures are silent so a submit never
     * blocks on a notify hiccup. */
    try {
      const title = 'Contribution submitted · awaiting verification';
      const body  = `${evt.title} · ₹${Number(st.amount).toLocaleString('en-IN')}. The committee will verify shortly.`;
      const link  = `#/e/${evt.id}`;
      if (st.on_behalf) {
        notifyEmit({ audience: 'user', userEmail: user.email,             kind: 'contrib.submit', title: 'Submitted on behalf of ' + st.contributor_name, body, link });
        notifyEmit({ audience: 'user', userEmail: st.contributor_email,   kind: 'contrib.submit', title, body: body + ' Filed on your behalf by ' + (user.name || user.email) + '.', link });
      } else {
        notifyEmit({ audience: 'user', userId: user.id, userEmail: user.email, kind: 'contrib.submit', title, body, link });
      }
    } catch (_e) { /* silent */ }
    toast('Submitted · awaiting committee verification', 'ok');
    state.clearContribDraft(evt.id);
    navigate('/e/' + evt.id);
  } } }, 'Submit for verification');

  const form = el('div', { class: 'card card-pad' },
    el('h2', { text: 'Contribute · ' + evt.title }),
    el('p', { class: 'sub', text: 'Every rupee goes to the committee. The receipt is minted and made available for download only after the Management Committee verifies your payment.' }),
    el('small', { class: 'sub', style: 'display:block;margin-bottom:14px', text: 'Fields marked with an asterisk (*) are required.' }),
    /* Contributor identity section — first thing residents see. */
    identityHead,
    identitySub,
    nameField,
    emailField,
    mobileField,
    flatField,
    behalfRow,
    filledByChip,
    /* Amount / payment section. */
    showTiers ? el('div', { class: 'field' },
      el('label', {}, el('span', { text: 'Choose an amount' }), el('span', { class: 'req', 'aria-hidden': 'true', text: '*' })),
      tierGrid
    ) : null,
    (showCustom || !showTiers) ? el('div', { class: 'field' },
      el('label', { for: 'amt' }, el('span', { text: 'Amount (₹)' }), el('span', { class: 'req', 'aria-hidden': 'true', text: '*' })),
      amtInp
    ) : null,
    el('div', { class: 'field' }, el('label', { text: 'Payment method' }), methodSel),
    payHint,
    /* Payment verification group. Rule: UPI/bank submissions need EITHER
     * the reference (UTR / txn no.) OR the payment proof — not both.
     * The `*` sits on the group heading, not the individual fields, so
     * residents don't misread it as "both required". */
    el('div', { class: 'field', style: 'padding:12px;border:1px dashed var(--line);border-radius:12px;background:#fbf6ea' },
      el('label', { style: 'margin-bottom:2px' },
        el('span', { text: 'Payment verification (any one of the two)' }),
        el('span', { class: 'req', 'aria-hidden': 'true', text: '*' })
      ),
      el('small', { class: 'sub', style: 'display:block;margin-bottom:10px', text: 'Either paste the UPI / bank reference number OR attach a screenshot / PDF of the transaction. One of the two is enough for the committee to verify.' }),
      el('div', {}, refLabel, refInp),
      el('div', { style: 'text-align:center;color:var(--muted);font-weight:800;font-size:12px;letter-spacing:.12em;margin:10px 0', text: '— OR —' }),
      el('div', {}, proofLabel, proofInp, proofStatus, proofPreview)
    ),
    el('div', { class: 'field' },
      el('label', { text: 'Need help updating contribution details? Add note' }),
      noteInp,
      el('small', { class: 'sub', text: 'Use this if a committee member needs to correct your entry or payment details.' })
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
  refreshIdentityLabels();
  persistDraft();
  mount(root, form);
}
