/* Event detail view — public read-only + admin edit tabs. */
'use strict';
import { el, mount, fmtDate, fmtINR, daysLeft, toast, modal } from '../dom.js';
import { findEvent, totalFor, verifiedCount, publicBoardFor, saveEvent, STATUS, contribsFor, canViewEventDetailedReport, nextStatusesFor, isTransitionAllowed } from '../events.js';
import { catalog, isEventOn, validateEventFeatures } from '../features.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { navigate } from '../router.js';
import { cfg, getSociety, state } from '../store.js';

/* ---------- payment-input validation helpers ----------
 * Both used ONLY inside the event editor (renderEdit). Kept module-
 * private so residents' contribute view can't accidentally weaken them.
 *
 * VPA format: NPCI spec allows [a-zA-Z0-9._-] before @ and an alnum
 * PSP handle after. We deliberately reject spaces, `://`, and any
 * character outside the whitelist so a hostile string cannot break
 * out of the `pa=` param of the upi:// intent URL.
 *
 * QR image whitelist: only PNG / JPEG / WebP (raster). SVG is
 * EXPLICITLY rejected because <svg> can carry <script> that executes
 * when rendered as a data URL. GIF is rejected too (animated QR
 * codes are bogus). Size cap keeps localStorage bounded. */
const VPA_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,30}$/;
const QR_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const QR_MAX_BYTES = 350 * 1024;   // 350 KB post-shrink cap
async function readQrDataUrl(file) {
  if (!file) throw new Error('No file selected');
  if (!QR_ALLOWED_MIME.has(file.type)) throw new Error('QR must be a PNG, JPEG, or WebP image (SVG not allowed)');
  if (/\.svg$/i.test(file.name || '')) throw new Error('SVG QR codes are not allowed');
  if (file.size > 4 * 1024 * 1024) throw new Error('QR image too large (>4 MB)');
  const raw = await new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload  = () => ok(String(r.result || ''));
    r.onerror = () => ko(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
  /* Re-encode via canvas: strips EXIF, drops any embedded scripts,
   * downscales to <= 600 px, and guarantees the output MIME is one
   * of the allow-listed rasters. */
  const img = new Image();
  await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('Image decode failed')); img.src = raw; });
  const MAX_DIM = 600;
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    const url = cv.toDataURL('image/png', q);
    if (url.length * 0.75 <= QR_MAX_BYTES) return url;
  }
  const url = cv.toDataURL('image/jpeg', 0.7);
  if (url.length * 0.75 > QR_MAX_BYTES) throw new Error('QR image too large after re-encoding');
  return url;
}

export async function render(root, { match }) {
  const evt = findEvent(match.id);
  if (!evt) return mount(root, el('div', { class: 'card card-pad' }, el('h2', { text: 'Event not found.' })));
  const user = session();
  const mode = match.mode || 'view';
  const canEdit = await can(user, 'events.edit.own');
  const canPublish = await can(user, 'events.publish');
  const canClose = await can(user, 'events.close');
  const canVerify = await can(user, 'contributions.verify');
  const canHistoryView = await can(user, 'events.history.view');
  const canReportView = await can(user, 'reports.view');

  if (mode === 'edit' && canEdit) return renderEdit(root, evt, user, { canPublish, canClose });
  if (mode === 'manage' && canVerify) return renderManage(root, evt, user, { canHistoryView });

  /* View mode: residents (and anonymous) only see the event once it
   * is PUBLISHED (or CLOSED, so past events remain browsable).
   * Draft / review / archived stay hidden from the public. Committee
   * members with edit or verify access always see the full page so
   * they can preview a draft before publishing. */
  const canPreview = canEdit || canVerify;
  if (!canPreview && evt.status !== STATUS.PUBLISHED && evt.status !== STATUS.CLOSED) {
    return mount(root, el('div', { class: 'card card-pad' },
      el('h2', { text: 'Not published yet' }),
      el('p', { class: 'sub', text: 'This event is being prepared by the committee. It will appear here once it is published.' }),
      el('a', { class: 'btn', href: '#/events', style: 'margin-top:8px' }, 'Browse events')
    ));
  }

  const hero = el('section', { class: 'hero', style: heroBg(evt) },
    el('div', { class: 'row row-between' },
      el('div', {},
        el('div', { class: 'pill', text: evt.glyph + ' ' + evt.template.toUpperCase() }),
        el('h1', { text: evt.title }),
        el('p', { class: 'sub', text: evt.purpose || 'Community event created by the committee.' })
      ),
      el('div', { class: 'row' },
        canEdit ? el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}/edit` }, 'Edit') : null,
        canVerify ? el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}/manage` }, 'Manage') : null,
        evt.status === STATUS.PUBLISHED && await isEventOn('contribution.voluntary', evt) ? el('a', { class: 'btn', href: `#/e/${evt.id}/contribute` }, 'Contribute') : null,
        evt.status === STATUS.PUBLISHED && await isEventOn('registration.on', evt) ? el('a', { class: 'btn btn-sage', href: `#/e/${evt.id}/register` }, 'Register') : null
      )
    )
  );
  const chosenVisual = await resolveFestivalVisual(evt);
  if (chosenVisual && chosenVisual.image) {
    hero.append(el('div', { class: 'hero-visual' },
      el('img', { src: chosenVisual.image, alt: chosenVisual.label || '', loading: 'lazy' })
    ));
  }

  const showProgress = await isEventOn('reporting.progress', evt);
  const showBoard = await isEventOn('privacy.public_board', evt);
  const hideAmount = await isEventOn('privacy.amount_hidden', evt);
  const showSignedInReport = await isEventOn('reporting.event_detail_signedin', evt);
  const canOpenDetailedReport = showSignedInReport && await canViewEventDetailedReport(evt, user, canReportView);
  const goal = evt.goal || 0;
  const total = totalFor(evt.id);
  const pct = goal ? Math.min(100, Math.round((total / goal) * 100)) : 0;
  const dl = daysLeft(evt.end_at);
  /* Anonymous visitors get the event title + hero glyph only. Every
   * financial figure, contributor count, progress bar, and expense
   * row is behind the sign-in gate. Keeps the tile behaviour and the
   * detail behaviour consistent for non-members. */
  const isAnonymous = !user;

  if (isAnonymous) {
    const stats = el('div', { class: 'grid grid-2' },
      statCard('Status', String(evt.status || 'draft').toUpperCase()),
      statCard('Access', 'Sign in for details')
    );
    const gate = el('section', { class: 'card card-pad', style: 'margin-top:16px;text-align:center' },
      el('h3', { text: '🔒 Sign in to see schedule & finances' }),
      el('p', { class: 'sub', text: 'Contribution history, goal, timeline, and community expenses are visible to signed-in residents only.' }),
      el('a', { class: 'btn', href: '#/login', style: 'margin-top:6px' }, 'Sign in')
    );
    mount(root, hero, stats, gate);
    return;
  }

  const stats = el('div', { class: 'grid grid-4' },
    goal ? statCard('Goal', fmtINR(goal)) : null,
    statCard('Raised', fmtINR(total)),
    statCard('Contributors', String(verifiedCount(evt.id))),
    dl != null ? statCard('Time left', dl > 0 ? `${dl} days` : 'Closes today') : null
  );

  const progress = (showProgress && goal) ? el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { text: 'Progress' }),
    el('div', { class: 'progress' }, el('i', { style: { width: pct + '%' } })),
    el('div', { class: 'progress-meta' }, el('span', { text: fmtINR(total) + ' raised' }), el('span', { text: pct + '% of goal' }))
  ) : null;

  const board = showBoard ? await renderPublicBoard(evt, hideAmount, user) : null;
  const reportCard = canOpenDetailedReport
    ? el('section', { class: 'card card-pad', style: 'margin-top:16px' },
      el('h3', { text: 'Contribution report' }),
      el('p', { class: 'sub', text: 'Signed-in detailed list view for this event.' }),
      el('a', { class: 'btn', href: `#/reports/event/${evt.id}` }, 'View list report')
    )
    : null;

  /* Public expense ledger — shown when the society-level toggle
   * `expenses.residents_can_see` is ON, and only rows the treasurer
   * both verified AND flagged `visible_to_residents`. Keeps unverified
   * or opaque outflows out of the resident-facing view by default. */
  const publicExpenses = await renderPublicExpensesCard(evt, user);
  /* Signed-in users can submit expenses against the event (e.g.
   * volunteers who advanced petty cash). Committee verifies later. */
  const canSubmitExpense = user ? await can(user, 'expenses.record') : false;
  const submitExpenseCard = canSubmitExpense ? el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('div', { class: 'row row-between', style: 'flex-wrap:wrap;gap:8px' },
      el('div', {},
        el('h3', { style: 'margin:0', text: 'Report an expense you paid' }),
        el('small', { class: 'sub', text: 'Volunteers can log petty-cash spends. Committee verifies before it counts on the dashboard.' })
      ),
      el('button', { class: 'btn', on: { click: () => openExpenseDialog(evt, user, null, false, 'pending', async () => {
        toast('Expense submitted for verification.', 'ok');
        mountEventView();
      }) } }, '＋ Submit expense')
    )
  ) : null;

  const mountEventView = () => location.reload();

  mount(root, hero, stats, progress, board, publicExpenses, submitExpenseCard, reportCard);
}

async function renderPublicExpensesCard(evt, user) {
  try {
    const soc = await getSociety().catch(() => null);
    const cfgExp = (soc && soc.expenses) || {};
    if (!cfgExp.residents_can_see) return null;
    const rows = state.expenses()
      .filter(x => x && x.event_id === evt.id && x.visible_to_residents && x.status === 'verified')
      .sort((a, b) => String(b.verified_at || b.created_at || '').localeCompare(String(a.verified_at || a.created_at || '')));
    if (!rows.length) return null;
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
      el('h3', { text: 'Community expenses' }),
      el('p', { class: 'sub', text: `${rows.length} verified entr${rows.length === 1 ? 'y' : 'ies'} · ${fmtINR(total)} spent so far.` }),
      el('table', { class: 'table', style: 'margin-top:8px' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'When' }),
          el('th', { text: 'Category' }),
          el('th', { text: 'Description' }),
          el('th', { class: 'num', text: 'Amount' }),
        )),
        el('tbody', {}, ...rows.map(r => el('tr', {},
          el('td', { text: fmtDate(r.verified_at || r.created_at) }),
          el('td', { text: r.category || '—' }),
          el('td', { style: 'max-width:320px;white-space:normal', text: r.description || '' }),
          el('td', { class: 'num', text: fmtINR(r.amount) })
        )))
      )
    );
  } catch (_e) { return null; }
}

function heroBg(evt) {
  if (evt.hero_class === 'sage') return 'background:linear-gradient(120deg,#dbeacc,#b9d4a4)';
  if (evt.hero_class === 'gold') return 'background:linear-gradient(120deg,#f7dfad,#e6c078)';
  if (evt.hero_class === 'emerg') return 'background:linear-gradient(120deg,#f2c9c1,#e59d92)';
  return '';
}

let _festivalVisualsCache = null;
async function loadFestivalCatalog(cluster) {
  if (!_festivalVisualsCache) {
    try { _festivalVisualsCache = await cfg.festivalVisuals(); }
    catch (_e) { _festivalVisualsCache = { visuals: [] }; }
  }
  const list = Array.isArray(_festivalVisualsCache.visuals) ? _festivalVisualsCache.visuals : [];
  if (!cluster || cluster === 'festival') return list.filter(v => !v.cluster || v.cluster === 'festival');
  return [];
}
export async function resolveFestivalVisual(evt) {
  if (!evt || !evt.festival_visual_id) return null;
  const catalogList = await loadFestivalCatalog(evt.cluster);
  return catalogList.find(v => v.id === evt.festival_visual_id) || null;
}

function statCard(k, v) {
  return el('div', { class: 'card stat' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v })
  );
}

async function renderPublicBoard(evt, hideAmount, user) {
  const isResident = !!(user && user.role === 'resident');
  const rows = isResident
    ? publicBoardFor(evt.id)
    : contribsFor(evt.id)
        .filter(c => c.status !== 'void')
        .map(c => ({
          when: c.verified_at || c.created_at,
          name: c.anonymous ? 'Anonymous' : (c.contributor_name || '—'),
          flat: c.anonymous ? '' : (c.flat || ''),
          amount: c.hide_amount ? null : c.amount,
          status: c.status || 'pending',
          contribId: c.id,
          contributor: c.contributor || '',
          contributorEmail: c.contributor_email || '',
          createdBy: c.created_by || '',
          filledByEmail: c.filled_by_email || '',
        }))
        .sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  const canReceiptDownload = user ? await can(user, 'receipts.download') : false;
  const userEmail = user && user.email ? String(user.email).toLowerCase() : '';
  const userId = user && user.id ? String(user.id).toLowerCase() : '';
  const userName = user && user.name ? String(user.name).trim().toLowerCase() : '';
  const ownsRow = (r) => {
    const rowIds = [r.contributorEmail, r.contributor, r.createdBy, r.filledByEmail]
      .map((v) => String(v || '').toLowerCase())
      .filter(Boolean);
    const rowName = String(r.name || '').trim().toLowerCase();
    return (userEmail && rowIds.includes(userEmail))
      || (userId && rowIds.includes(userId))
      || (userName && rowName && userName === rowName);
  };
  const canViewReceipt = (r) => !!(user && !isResident && canReceiptDownload && r.contribId && String(r.status || '') === 'verified');
  const canDownloadOwnReceipt = (r) => !!(user && isResident && canReceiptDownload && r.contribId && String(r.status || 'verified') === 'verified' && ownsRow(r));
  const body = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'When' }),
      el('th', { text: 'Contributor' }),
      el('th', { text: 'Flat' }),
      el('th', { class: 'num', text: 'Amount' }),
      !isResident ? el('th', { class: 'num', text: 'Status' }) : null,
      el('th', { class: 'num', text: 'Receipt' })
    )),
    el('tbody', {}, ...(rows.length ? rows.slice(0, 20).map(r => el('tr', {},
      el('td', { text: fmtDate(r.when) }),
      el('td', { text: r.name }),
      el('td', { text: r.flat }),
      el('td', { class: 'num', text: (r.amount == null || hideAmount) ? '—' : fmtINR(r.amount) }),
      !isResident
        ? el('td', { class: 'num' },
            el('small', { class: 'pill ' + (String(r.status || '') === 'verified' ? 'ok' : 'warn'), text: String(r.status || '').toUpperCase() || 'PENDING' })
          )
        : null,
      el('td', { class: 'num' },
        canViewReceipt(r)
          ? el('span', { class: 'tvh-receipt-actions' },
              el('a', {
                class: 'tvh-mini-icon-btn',
                href: `#/receipt/${encodeURIComponent(r.contribId)}`,
                title: 'View receipt',
                'aria-label': 'View receipt'
              }, '👁'),
              el('a', {
                class: 'tvh-mini-icon-btn',
                href: `#/receipt/${encodeURIComponent(r.contribId)}?download=1`,
                title: 'Download receipt PDF',
                'aria-label': 'Download receipt PDF'
              }, '⬇')
            )
          : canDownloadOwnReceipt(r)
            ? el('span', { class: 'tvh-receipt-actions' },
              el('a', {
                class: 'tvh-mini-icon-btn',
                href: `#/receipt/${encodeURIComponent(r.contribId)}?download=1`,
                title: 'Download receipt PDF',
                'aria-label': 'Download receipt PDF'
              }, '⬇')
            )
          : el('small', { class: 'sub', text: '—' })
      )
    )) : [el('tr', {}, el('td', { colspan: isResident ? 5 : 6, text: 'No contributions in scope yet.', style: 'text-align:center;color:var(--muted)' }))]))
  );
  return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { text: '🌸 Contributor board' }),
    canReceiptDownload
      ? el('p', { class: 'sub', style: 'margin:0 0 8px', text: isResident
        ? 'Residents can download (⬇) their own verified receipts only.'
        : 'Access roles can view (👁) and download (⬇) verified receipts from here.' })
      : null,
    body
  );
}

/* ---------- edit view ---------- */
async function renderEdit(root, evt, user, caps) {
  const cat = await catalog();
  const canHistoryConfigure = await can(user, 'events.history.configure');
  const form = el('form', { class: 'card card-pad', on: { submit: e => e.preventDefault() } });

  const festivalCatalog = await loadFestivalCatalog(evt.cluster);
  const visualSel = festivalCatalog.length
    ? el('select', {},
        el('option', { value: '', selected: !evt.festival_visual_id, text: 'No image (use gradient hero)' }),
        ...festivalCatalog.map(v => el('option', {
          value: v.id,
          selected: evt.festival_visual_id === v.id,
          text: v.label,
        }))
      )
    : null;
  const visualPreview = el('img', {
    alt: '',
    style: 'display:none;max-width:100%;border-radius:12px;margin-top:8px;border:1px solid var(--line);background:#fff',
  });
  function refreshVisualPreview() {
    const chosen = festivalCatalog.find(v => v.id === (visualSel && visualSel.value));
    if (chosen && chosen.image) {
      visualPreview.src = chosen.image;
      visualPreview.style.display = 'block';
    } else {
      visualPreview.removeAttribute('src');
      visualPreview.style.display = 'none';
    }
  }
  if (visualSel) {
    visualSel.addEventListener('change', refreshVisualPreview);
    refreshVisualPreview();
  }
  const visualI = visualSel
    ? el('div', { class: 'field' },
        el('label', { text: 'Festival visual (shown on event card + hero)' }),
        visualSel,
        el('small', { class: 'sub', text: 'Optional. Choose a curated festival visual so residents recognise the event at a glance.' }),
        visualPreview
      )
    : null;

  const titleI = field('title', 'Event title', el('input', { type: 'text', value: evt.title, required: true }));
  const purposeI = field('purpose', 'Purpose (1-line)', el('input', { type: 'text', value: evt.purpose || '' }));
  const goalI = field('goal', 'Goal (₹)', el('input', { type: 'number', value: String(evt.goal || 0), min: '0' }));
  const startI = field('start', 'Start date', el('input', { type: 'date', value: evt.start_at || '' }));
  const endI = field('end', 'End / deadline', el('input', { type: 'date', value: evt.end_at || '' }));
  const capI = field('cap', 'Capacity', el('input', { type: 'number', value: String(evt.capacity || 0), min: '0' }));
  const fixedI = field('fixed', 'Fixed amount (₹, if applicable)', el('input', { type: 'number', value: String(evt.fixed_amount || 0), min: '0' }));
  const suggestedRows = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  function addSuggestedRow(amount) {
    const inp = el('input', {
      type: 'number',
      min: '1',
      step: '1',
      value: amount ? String(amount) : '',
      placeholder: 'Amount in ₹',
      'data-suggested-amount': '1'
    });
    const removeBtn = el('button', {
      type: 'button',
      class: 'btn btn-ghost btn-sm',
      on: { click: () => row.remove() }
    }, 'Remove');
    const row = el('div', { class: 'row', style: 'gap:8px;align-items:center' }, inp, removeBtn);
    suggestedRows.append(row);
  }
  const existingSuggested = Array.isArray(evt.tiers)
    ? evt.tiers.map(t => Number(t && t.amount)).filter(n => Number.isFinite(n) && n > 0)
    : [];
  if (existingSuggested.length) existingSuggested.forEach(addSuggestedRow);
  else addSuggestedRow('');
  const suggestedI = el('div', { class: 'field' },
    el('label', { text: 'Suggested contribution amounts (₹)' }),
    suggestedRows,
    el('div', { style: 'margin-top:8px' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => addSuggestedRow('') } }, '+ Add amount')
    ),
    el('small', {
      id: 'evt-suggested-help',
      class: 'sub',
      text: 'Add one by one. Residents can tap these quickly in the contribute form.'
    })
  );
  const appreciateI = el('div', { class: 'field' },
    el('label', { text: 'Appreciation note shown on contribute screen (optional)' }),
    el('input', {
      type: 'text',
      value: evt.appreciation_note || '',
      maxlength: '160',
      placeholder: 'It would be wonderful if you could contribute a minimum of {amount}. This is completely voluntary.'
    }),
    el('small', { class: 'sub', text: 'Polite suggestion only. Use {amount} to insert the selected amount dynamically.' })
  );

  /* ---------- payment / collection details (per-event) ----------
   * The event creator must publish EITHER a UPI VPA OR a QR code (or
   * both) so residents can pay directly from the contribute form.
   * Falls back to society-wide payment settings if the creator leaves
   * both blank. All input is validated & sanitized (VPA regex, image
   * MIME whitelist, canvas re-encode) before persistence. */
  const upiVpaInp = el('input', {
    type: 'text', value: evt.payment_upi_vpa || '', placeholder: 'e.g. society@upi',
    inputmode: 'email', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    'aria-describedby': 'evt-upi-help'
  });
  const upiVpaHelp = el('small', { id: 'evt-upi-help', class: 'sub',
    text: 'Virtual Payment Address in the form name@bank (e.g. society@sbi). Residents will tap to open their UPI app pre-filled.' });
  const upiNameInp = el('input', {
    type: 'text', value: evt.payment_upi_name || '',
    placeholder: 'Payee display name (optional)', maxlength: '60'
  });
  const upiVpaI = el('div', { class: 'field' },
    el('label', { for: 'evt-upi-vpa', text: 'UPI VPA for this event' }), upiVpaInp, upiVpaHelp
  );
  const upiNameI = el('div', { class: 'field' },
    el('label', { text: 'Payee display name (shown to residents)' }), upiNameInp
  );

  /* QR upload: hold the (sanitized) data-URL in state; render current
   * preview if already saved. `remove` button clears it. */
  let qrDataUrl = evt.payment_qr_data_url || '';
  const qrPreview = el('img', {
    src: qrDataUrl, alt: 'Current payment QR',
    style: 'display:' + (qrDataUrl ? 'block' : 'none') + ';max-width:180px;margin:8px 0;border:1px solid var(--line);border-radius:8px;background:#fff;padding:6px'
  });
  const qrStatus = el('small', { class: 'sub',
    text: qrDataUrl ? 'A QR is currently saved for this event.' : 'Optional: upload the payment QR code (PNG, JPEG, or WebP only; SVG not allowed).' });
  const qrInp = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  qrInp.addEventListener('change', async () => {
    const f = qrInp.files && qrInp.files[0];
    if (!f) return;
    try {
      qrDataUrl = await readQrDataUrl(f);
      qrPreview.src = qrDataUrl;
      qrPreview.style.display = 'block';
      qrStatus.textContent = `Loaded ${f.name} · ~${Math.round((qrDataUrl.length * 0.75) / 1024)} KB (re-encoded).`;
    } catch (e) {
      qrInp.value = '';
      qrStatus.textContent = e.message || 'Could not attach that file.';
      toast(e.message || 'QR upload failed', 'err');
    }
  });
  const qrRemoveBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => {
    qrDataUrl = ''; qrInp.value = '';
    qrPreview.src = ''; qrPreview.style.display = 'none';
    qrStatus.textContent = 'QR removed. Save to persist.';
  } } }, 'Remove QR');
  const qrI = el('div', { class: 'field' },
    el('label', { text: 'Payment QR code (optional)' }),
    qrInp, qrStatus, qrPreview,
    el('div', {}, qrRemoveBtn)
  );

  /* ---------- one-contribution-per-flat toggle ----------
   * When ticked, the contribute form rejects a second submission from
   * the same flat (any status except void counts). Useful for events
   * where each flat pays a fixed share (e.g. maintenance top-up,
   * per-flat festival levy). Default OFF so donation-style drives
   * still accept top-ups. Enforced client-side today; the same rule
   * runs in `addContribution` guard so the check can't be bypassed
   * by editing the form in devtools. */
  const oncePerFlatChk = el('input', { type: 'checkbox', checked: !!evt.one_per_flat });
  const oncePerFlatI = el('div', { class: 'field' },
    el('label', { class: 'check-row' },
      oncePerFlatChk,
      el('span', {},
        el('div', { class: 'name', text: 'One contribution per flat' }),
        el('small', { class: 'sub', text: 'When ON, each flat can submit only once for this event. Leave OFF to allow multiple contributions from the same flat (donation drives, top-ups, etc.).' })
      )
    )
  );
  const histOnChk = el('input', {
    type: 'checkbox',
    checked: !!evt.history_enabled || !!(evt.features && evt.features['event.moderator_history']),
    disabled: !canHistoryConfigure
  });
  const reportSignedInChk = el('input', {
    type: 'checkbox',
    checked: !!evt.report_public_signedin || !!(evt.features && evt.features['reporting.event_detail_signedin'])
  });
  const reportAllowlistChk = el('input', { type: 'checkbox', checked: !!evt.report_restrict_allowlist });
  const governanceFeatureIds = new Set(['event.moderator_history', 'reporting.event_detail_signedin']);
  const governanceI = el('div', { class: 'field' },
    el('label', { class: 'check-row' },
      histOnChk,
      el('span', {},
        el('div', { class: 'name', text: 'Record moderator history for this event' }),
        el('small', { class: 'sub', text: canHistoryConfigure
          ? 'Tracks committee/manager actions on this event for MC+ review.'
          : 'Only Management Committee / Secretary / Admin can toggle this.' })
      )
    ),
    el('label', { class: 'check-row' },
      reportSignedInChk,
      el('span', {},
        el('div', { class: 'name', text: 'Allow signed-in users to view event contribution list report' }),
        el('small', { class: 'sub', text: 'Publishes a list view at Reports for this specific event.' })
      )
    ),
    el('label', { class: 'check-row' },
      reportAllowlistChk,
      el('span', {},
        el('div', { class: 'name', text: 'Restrict event report to resident email allowlist' }),
        el('small', { class: 'sub', text: 'Only emails added in Settings -> Resident email governance can open this event report.' })
      )
    )
  );

  const clusters = cat.clusters.filter(c => cat.features.some(f => f.cluster === c.id && f.scope === 'event'));
  const featureChecks = new Map();
  const featurePanel = el('section', { style: 'margin-top:14px' }, el('h3', { text: 'Feature configuration' }),
    ...clusters.map(cl => el('div', { class: 'panel' },
      el('h4', { text: cl.label }),
      ...cat.features.filter(f => f.cluster === cl.id && f.scope === 'event' && !governanceFeatureIds.has(f.id)).map(f => {
        const on = evt.features[f.id] === undefined ? !!f.default : !!evt.features[f.id];
        const cb = el('input', { type: 'checkbox', checked: on });
        featureChecks.set(f.id, cb);
        return el('label', { class: 'check-row' }, cb, el('span', {}, el('div', { class: 'name', text: f.label }), (f.depends_on || []).length ? el('small', { text: 'depends on: ' + f.depends_on.join(', ') }) : null));
      })
    ))
  );

  const statusSel = el('select', {},
    ...nextStatusesFor(evt.status).map(s => el('option', { value: s, selected: evt.status === s, text: s.charAt(0).toUpperCase() + s.slice(1) }))
  );
  const statusHelp = evt.status === STATUS.PUBLISHED
    ? el('small', { class: 'sub', style: 'display:block;margin-top:4px', text: 'Published events cannot be moved back to draft/review — contributions stay linked. Use Close or Archive when the event is over.' })
    : null;

  const actions = el('div', { class: 'row row-between', style: 'margin-top:16px' },
    el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}` }, 'Cancel'),
    el('div', { class: 'row', style: 'flex-wrap:wrap' },
      el('div', {},
        el('div', { class: 'row', style: 'gap:6px;align-items:center' },
          el('span', { text: 'Status:' }),
          statusSel,
        ),
        statusHelp
      ),
      el('button', { class: 'btn', on: { click: async () => {
        /* Validate the UPI VPA if the creator entered one. Blank is
         * fine (falls back to society-wide settings) but a non-blank
         * VPA must match the strict NPCI-ish regex to prevent
         * smuggling arbitrary characters into the `pa=` URL param. */
        const vpaRaw = (upiVpaInp.value || '').trim();
        if (vpaRaw && !VPA_RE.test(vpaRaw)) {
          toast('UPI VPA looks invalid. Expected format: name@bank', 'err');
          upiVpaInp.focus();
          return;
        }
        const reportSignedInOn = !!reportSignedInChk.checked;
        const historyOn = canHistoryConfigure ? !!histOnChk.checked : !!evt.history_enabled;
        const updatedFeatures = Object.fromEntries(Array.from(featureChecks.entries()).map(([k, cb]) => [k, cb.checked]));
        updatedFeatures['event.moderator_history'] = historyOn;
        updatedFeatures['reporting.event_detail_signedin'] = reportSignedInOn;

        const updated = {
          ...evt,
          tiers: tiersFromRows(suggestedRows),
          appreciation_note: (appreciateI.querySelector('input').value || '').trim().slice(0, 160),
          title: titleI.querySelector('input').value.trim() || evt.title,
          purpose: purposeI.querySelector('input').value.trim(),
          goal: Number(goalI.querySelector('input').value || 0),
          start_at: startI.querySelector('input').value || evt.start_at,
          end_at: endI.querySelector('input').value || evt.end_at,
          capacity: Number(capI.querySelector('input').value || 0),
          fixed_amount: Number(fixedI.querySelector('input').value || 0),
          payment_upi_vpa:  vpaRaw,
          payment_upi_name: (upiNameInp.value || '').trim().slice(0, 60),
          payment_qr_data_url: qrDataUrl,
          one_per_flat: !!oncePerFlatChk.checked,
          history_enabled: historyOn,
          report_public_signedin: reportSignedInOn,
          report_restrict_allowlist: !!reportAllowlistChk.checked,
          features: updatedFeatures,
          status: statusSel.value,
          festival_visual_id: visualSel ? (visualSel.value || '') : (evt.festival_visual_id || ''),
        };
        const errs = await validateEventFeatures(updated.features);
        if (errs.length) { toast(`Fix dependencies: ${errs[0].id} needs ${errs[0].missing}`, 'err'); return; }
        if (!isTransitionAllowed(evt.status, updated.status)) {
          toast(`Cannot change status from "${evt.status}" to "${updated.status}". Published events can only move to Closed / Archived to preserve contributions.`, 'err');
          return;
        }
        if (updated.status === STATUS.PUBLISHED && !caps.canPublish) { toast('You cannot publish. Ask Management Committee.', 'err'); return; }
        /* Four-eyes gate: when society.events.require_approval is ON,
         * the person who drafted the event may not publish it themselves
         * — a second committee member must click Publish. Admin bypasses
         * this gate so a single admin can always ship an urgent event. */
        if (updated.status === STATUS.PUBLISHED && evt.status !== STATUS.PUBLISHED) {
          try {
            const soc = await getSociety();
            const needsPeer = !!(soc && soc.events && soc.events.require_approval);
            const isAdmin = user && (user.role === 'admin' || user.role === 'mgmt');
            const drafter = evt.created_by || null;
            const meId = user && (user.email || user.id);
            if (needsPeer && !isAdmin && drafter && meId && drafter === meId) {
              toast('Society requires a second committee member to publish this event.', 'err');
              return;
            }
          } catch (_e) { /* if flag lookup fails, keep existing publish behaviour */ }
        }
        if (updated.status === STATUS.CLOSED && !caps.canClose) { toast('Only Management Committee can close.', 'err'); return; }
        try {
          await saveEvent(updated, user);
          toast('Event saved', 'ok');
          navigate('/e/' + updated.id);
        } catch (err) {
          toast((err && err.message) || 'Could not save event', 'err');
        }
      } } }, 'Save event')
    )
  );

  form.append(el('h2', { text: 'Edit event' }),
    el('div', { class: 'grid grid-2' }, titleI, purposeI, goalI, capI, startI, endI, fixedI, suggestedI, appreciateI),
    visualI ? el('section', { style: 'margin-top:14px' },
      el('h3', { text: 'Event visual' }),
      el('p', { class: 'sub', style: 'margin-bottom:10px', text: 'Cultural / festival events can display a curated illustration on the event grid and hero.' }),
      visualI
    ) : null,
    el('section', { style: 'margin-top:14px' },
      el('h3', { text: 'Payment / collection' }),
      el('p', { class: 'sub', style: 'margin-bottom:10px', text: 'Publish a UPI VPA and/or a QR code so residents can pay. If both are blank, society-wide payment settings are used.' }),
      el('div', { class: 'grid grid-2' }, upiVpaI, upiNameI),
      qrI,
      oncePerFlatI,
      governanceI
    ),
    featurePanel,
    actions
  );
  mount(root, form);
}

function tiersFromRows(rowsRoot) {
  const inputs = Array.from(rowsRoot.querySelectorAll('input[data-suggested-amount="1"]'));
  const seen = new Set();
  const vals = [];
  for (const inp of inputs) {
    const n = Number(inp.value || 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    const v = Math.round(n);
    if (seen.has(v)) continue;
    seen.add(v);
    vals.push(v);
  }
  return vals.map((amount, idx) => ({
    amount,
    label: idx === 0 ? 'Starter' : '',
    highlight: idx === 1,
  }));
}

function field(id, label, input) {
  return el('div', { class: 'field' }, el('label', { for: id, text: label }), input);
}

/* ---------- manage / verify view ---------- */
async function renderManage(root, evt, user, caps) {
  const items = contribsFor(evt.id);
  const head = el('section', { class: 'card card-pad' },
    el('h2', { text: 'Manage · ' + evt.title }),
    el('p', { class: 'sub', text: 'Verify or mark invalid. Verified contributions immediately mint a stamped receipt.' })
  );
  const tbl = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'When' }),
      el('th', { text: 'Contributor' }),
      el('th', { text: 'Flat' }),
      el('th', { text: 'Method' }),
      el('th', { text: 'Ref / proof' }),
      el('th', { class: 'num', text: 'Amount' }),
      el('th', { text: 'Status' }),
      el('th', { text: 'Actions' })
    )),
    el('tbody', {}, ...(items.length ? items.map(c => contribRow(c, evt, user, caps)) : [el('tr', {}, el('td', { colspan: 8, text: 'No contributions yet.', style: 'text-align:center;color:var(--muted)' }))]))
  );
  const sections = [head, el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' }, tbl)];
  const canRecordExpense = await can(user, 'expenses.record');
  const canViewExpense   = await can(user, 'expenses.view');
  if (canViewExpense) sections.push(await renderExpensesPanel(evt, user, { canRecord: canRecordExpense, caps }));
  if (caps && caps.canHistoryView) sections.push(renderHistoryPanel(evt));
  mount(root, ...sections);
}

/* ---------- expenses (per-event outflows) ----------
 * Committee / manager record cash-out entries against an event
 * (e.g. mandap booking, prasad, decorations). Each row optionally
 * carries a receipt URL and a per-row "Visible to residents" toggle
 * whose default is seeded from Settings → Expense preferences.
 * Rows show up in Reports alongside contributions so the treasurer
 * can produce net-cash reports for a campaign. */
async function renderExpensesPanel(evt, user, { canRecord, caps }) {
  const soc = await getSociety().catch(() => null);
  const expenseCfg = (soc && soc.expenses) || {};
  const defaultVisible = !!expenseCfg.default_visible_to_residents;
  const canVerify = await can(user, 'expenses.verify');
  const rows = state.expenses().filter(x => x && x.event_id === evt.id)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const verified = rows.filter(r => r.status === 'verified');
  const pendingRows = rows.filter(r => r.status === 'pending' || !r.status);
  const verifiedTotal = verified.reduce((s, r) => s + Number(r.amount || 0), 0);
  const pendingTotal  = pendingRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const collected = totalFor(evt.id);
  const net = collected - verifiedTotal;

  const head = el('div', { class: 'row row-between', style: 'padding:16px 16px 8px;flex-wrap:wrap;gap:8px' },
    el('div', {},
      el('h3', { style: 'margin:0', text: 'Expenses' }),
      el('small', { class: 'sub', text: `${verified.length} verified (${fmtINR(verifiedTotal)}) · ${pendingRows.length} pending (${fmtINR(pendingTotal)}) · ${fmtINR(net)} net (collected − verified)` })
    ),
    canRecord ? el('button', { class: 'btn btn-sm', on: { click: () => openExpenseDialog(evt, user, null, defaultVisible, canVerify ? 'verified' : 'pending', () => renderManage(document.getElementById('main'), evt, user, caps)) } }, '＋ Add expense') : null
  );

  const tbl = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'When' }),
      el('th', { text: 'Category' }),
      el('th', { text: 'Description' }),
      el('th', { text: 'Receipt' }),
      el('th', { class: 'num', text: 'Amount' }),
      el('th', { text: 'Status' }),
      el('th', { text: 'Visible to residents' }),
      (canRecord || canVerify) ? el('th', { text: 'Actions' }) : null
    )),
    el('tbody', {}, ...(rows.length ? rows.map(r => expenseRow(r, evt, user, { canRecord, canVerify, caps })) : [
      el('tr', {}, el('td', { colspan: (canRecord || canVerify) ? 8 : 7, text: canRecord ? 'No expenses recorded yet. Tap "Add expense" to record the first one.' : 'No expenses recorded yet.', style: 'text-align:center;color:var(--muted);padding:14px' }))
    ]))
  );

  return el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' }, head, tbl);
}

function expenseRow(r, evt, user, { canRecord, canVerify, caps }) {
  const isOwn = r.created_by && user && String(r.created_by).toLowerCase() === String(user.email || user.id || '').toLowerCase();
  const status = r.status || 'pending';
  const canEditThis = canRecord && (canVerify || isOwn);
  const canDeleteThis = canRecord && (canVerify || (isOwn && status !== 'verified'));
  const visToggle = el('input', {
    type: 'checkbox',
    checked: !!r.visible_to_residents,
    disabled: !canVerify,
    on: { change: (e) => {
      const list = state.expenses();
      const rec = list.find(x => x && x.id === r.id);
      if (!rec) return;
      rec.visible_to_residents = !!e.target.checked;
      rec.updated_at = new Date().toISOString();
      state.saveExpenses(list);
      state.audit({ actor: user && user.email || null, action: 'expense.visibility', expense: rec.id, event: evt.id, detail: rec.visible_to_residents ? 'shown' : 'hidden' });
      toast(rec.visible_to_residents ? 'Now visible to residents' : 'Hidden from residents', 'ok');
    } }
  });
  const pillCls = status === 'verified' ? 'pill pill-sage' : status === 'void' ? 'pill pill-muted' : 'pill';
  const pillText = status === 'void' ? 'invalid' : status;
  return el('tr', {},
    el('td', { text: fmtDate(r.created_at) }),
    el('td', { text: r.category || '—' }),
    el('td', { style: 'max-width:280px;white-space:normal', text: (r.description || '') + (r.created_by && !canVerify ? '' : (r.created_by ? ` · by ${r.created_by}` : '')) }),
    el('td', {}, r.receipt_url || r.proof_data_url
      ? el('div', { style: 'display:flex;flex-direction:column;gap:4px;align-items:flex-start' },
          r.receipt_url ? el('a', { class: 'btn btn-sm btn-ghost', href: r.receipt_url, target: '_blank', rel: 'noopener' }, '🔗 URL') : null,
          r.proof_data_url ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => openExpenseProof(r) } }, '🖼 View proof') : null
        )
      : el('span', { class: 'sub', text: '—' })
    ),
    el('td', { class: 'num', text: fmtINR(r.amount) }),
    el('td', {}, el('span', { class: pillCls, text: pillText })),
    el('td', {}, visToggle),
    (canRecord || canVerify) ? el('td', {}, el('div', { class: 'row' },
      (canVerify && status === 'pending') ? el('button', { class: 'btn btn-sm', on: { click: () => verifyExpense(r, evt, user, caps) } }, 'Verify') : null,
      canEditThis ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => openExpenseDialog(evt, user, r, !!r.visible_to_residents, status, () => renderManage(document.getElementById('main'), evt, user, caps)) } }, 'Edit') : null,
      canDeleteThis ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => confirmDeleteExpense(r, evt, user, caps) } }, 'Delete') : null
    )) : null
  );
}

function verifyExpense(r, evt, user, caps) {
  const list = state.expenses();
  const rec = list.find(x => x && x.id === r.id);
  if (!rec) return;
  const nowIso = new Date().toISOString();
  rec.status = 'verified';
  rec.verified_at = nowIso;
  rec.verified_by = user && (user.email || user.id) || 'unknown';
  rec.updated_at = nowIso;
  state.saveExpenses(list);
  state.audit({ actor: user && user.email || null, action: 'expense.verify', expense: rec.id, event: evt.id, amount: rec.amount });
  toast('Expense verified. Now counts in the ledger.', 'ok');
  renderManage(document.getElementById('main'), evt, user, caps);
}

export function openExpenseDialog(evt, user, existing, defaultVisible, statusHint, onDone) {
  const isEdit = !!existing;
  const inpAmount = el('input', { type: 'number', min: '0', step: '1', value: existing ? String(existing.amount || '') : '', placeholder: '2500', required: true });
  const inpCategoryOther = el('input', { type: 'text', maxlength: '48', value: '', placeholder: 'Type category (e.g. hall booking)', style: 'margin-top:6px;display:none' });
  const selCategory = el('select', { required: true, 'aria-label': 'Category' });
  const inpDescription = el('textarea', { rows: 2, maxlength: '240', placeholder: 'What was this spent on?', value: existing ? (existing.description || '') : '' });
  const inpReceiptUrl = el('input', { type: 'url', maxlength: '400', value: existing ? (existing.receipt_url || '') : '', placeholder: 'https:// (optional link to invoice / receipt)' });
  // Event picker for global submissions (called with evt=null). Includes
  // published, closed and archived events so expenses can be filed even
  // after an event ends (e.g. late reimbursement).
  const canPickEvent = !evt && !isEdit;
  const eligibleStatuses = new Set([STATUS.PUBLISHED, STATUS.CLOSED, STATUS.ARCHIVED]);
  const statusLabel = (s) => s === STATUS.PUBLISHED ? 'live' : (s === STATUS.CLOSED ? 'closed' : (s === STATUS.ARCHIVED ? 'archived' : s));
  const eligibleEvents = canPickEvent
    ? state.events()
        .filter(e => e && eligibleStatuses.has(e.status))
        .sort((a, b) => {
          const rank = (s) => s === STATUS.PUBLISHED ? 0 : (s === STATUS.CLOSED ? 1 : 2);
          const dr = rank(a.status) - rank(b.status);
          return dr !== 0 ? dr : String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
        })
    : [];
  const selEvent = canPickEvent ? el('select', { required: true },
    el('option', { value: '', text: '— choose an event —', selected: true }),
    ...eligibleEvents.map(e => el('option', {
      value: e.id,
      text: `${e.title || e.id} · ${statusLabel(e.status)}`
    }))
  ) : null;
  const cbVisible = el('input', { type: 'checkbox' });
  cbVisible.checked = existing ? !!existing.visible_to_residents : !!defaultVisible;
  /* Proof upload — the submitter can attach an image / PDF of the
   * paid receipt. Stored inline as a data URL so the moderator can
   * review it before verifying (same pattern used for contribution
   * proof screenshots). Accepted MIME whitelist matches the guard
   * in `readExpenseProof()` below. */
  const PROOF_MAX_BYTES = 900 * 1024; /* ~700 KB raw pre base64-encode */
  const proofState = {
    data_url: existing && existing.proof_data_url ? String(existing.proof_data_url) : '',
    name:     existing && existing.proof_name     ? String(existing.proof_name)     : '',
    size:     existing && existing.proof_size     ? Number(existing.proof_size)     : 0,
  };
  const inpProof = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,application/pdf' });
  const proofStatus = el('small', { class: 'sub', style: 'display:block;margin-top:6px',
    text: proofState.data_url
      ? `Attached: ${proofState.name || 'receipt'} · ${(proofState.size ? Math.round(proofState.size / 1024) + ' KB' : '?')}`
      : 'Optional. Image (PNG/JPEG/WebP/HEIC) or PDF up to ~700 KB.'
  });
  const proofPreview = el('img', {
    src: proofState.data_url && /^data:image\//.test(proofState.data_url) ? proofState.data_url : '',
    alt: 'expense proof preview',
    style: 'display:' + (proofState.data_url && /^data:image\//.test(proofState.data_url) ? 'block' : 'none') + ';max-width:220px;max-height:180px;margin-top:6px;border:1px solid var(--line);border-radius:6px'
  });
  const proofRemoveBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', style: 'margin-top:6px' }, 'Remove attached proof');
  proofRemoveBtn.hidden = !proofState.data_url;
  proofRemoveBtn.style.display = proofState.data_url ? '' : 'none';
  proofRemoveBtn.addEventListener('click', () => {
    proofState.data_url = ''; proofState.name = ''; proofState.size = 0;
    inpProof.value = '';
    proofPreview.src = ''; proofPreview.style.display = 'none';
    proofRemoveBtn.hidden = true; proofRemoveBtn.style.display = 'none';
    proofStatus.textContent = 'Attached proof removed.';
  });
  inpProof.addEventListener('change', async () => {
    const f = inpProof.files && inpProof.files[0];
    if (!f) return;
    try {
      if (f.size > PROOF_MAX_BYTES) throw new Error('File is too large (>' + Math.round(PROOF_MAX_BYTES / 1024) + ' KB). Try a smaller image or PDF.');
      if (!/^(image\/(png|jpeg|webp|gif|heic|heif)|application\/pdf)$/i.test(f.type)) throw new Error('Only image or PDF files are accepted.');
      const dataUrl = await new Promise((ok, ko) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result || ''));
        r.onerror = () => ko(new Error('Could not read the file.'));
        r.readAsDataURL(f);
      });
      proofState.data_url = dataUrl;
      proofState.name = f.name;
      proofState.size = f.size;
      proofStatus.textContent = `Attached: ${f.name} · ${Math.round(f.size / 1024)} KB`;
      if (/^data:image\//.test(dataUrl)) {
        proofPreview.src = dataUrl;
        proofPreview.style.display = 'block';
      } else {
        proofPreview.src = '';
        proofPreview.style.display = 'none';
      }
      proofRemoveBtn.hidden = false;
      proofRemoveBtn.style.display = '';
    } catch (e) {
      inpProof.value = '';
      proofStatus.textContent = (e && e.message) || 'Could not attach that file.';
      toast(proofStatus.textContent, 'err');
    }
  });
  const proofField = el('div', {}, inpProof, proofStatus, proofPreview, proofRemoveBtn);

  // Field builder: shows a red asterisk on required fields; optional
  // fields carry an "info" affordance whose title reveals detail on
  // hover (desktop) or long-press (mobile — see ui.js longPressTooltip).
  const field = (label, help, ctrl, opts) => {
    const required = !!(opts && opts.required);
    const info = opts && opts.info;
    const labelEl = el('label', { class: 'lbl' },
      el('span', { text: label }),
      required ? el('span', { class: 'req-star', 'aria-label': 'required', text: '*' }) : null,
      !required ? el('span', { class: 'opt-tag', title: info || 'Optional', 'aria-label': info || 'Optional', text: 'optional' }) : null
    );
    return el('div', { class: 'field', style: 'margin-top:10px' },
      labelEl,
      help ? el('small', { class: 'sub', style: 'display:block;margin-bottom:4px', text: help }) : null,
      ctrl
    );
  };
  const willBePending = (statusHint === 'pending');
  const eventCtxLine = evt
    ? el('div', { class: 'row', style: 'gap:6px;align-items:center;margin:0 0 8px;flex-wrap:wrap' },
        el('small', { class: 'pill pill-muted', text: 'Event' }),
        el('strong', { text: evt.title || evt.id })
      )
    : null;

  // Load configurable categories from society config (any access role can
  // edit in Settings → Attributes → Expenses).
  (async () => {
    try {
      const soc = await getSociety().catch(() => null);
      const raw = (soc && soc.expenses && Array.isArray(soc.expenses.categories)) ? soc.expenses.categories : [];
      const cats = raw.map(v => String(v || '').trim()).filter(Boolean);
      const prior = existing && existing.category ? String(existing.category).trim() : '';
      const hasPrior = prior && cats.some(c => c.toLowerCase() === prior.toLowerCase());
      selCategory.replaceChildren(
        el('option', { value: '', text: '— select a category —', selected: !prior }),
        ...cats.map(c => el('option', { value: c, text: c, selected: hasPrior && prior.toLowerCase() === c.toLowerCase() })),
        el('option', { value: '__other', text: 'Other (specify)…', selected: !!(prior && !hasPrior) })
      );
      if (prior && !hasPrior) {
        inpCategoryOther.value = prior;
        inpCategoryOther.style.display = 'block';
      }
    } catch (_e) { /* ignore */ }
  })();
  selCategory.addEventListener('change', () => {
    const showOther = selCategory.value === '__other';
    inpCategoryOther.style.display = showOther ? 'block' : 'none';
    if (showOther) setTimeout(() => inpCategoryOther.focus(), 30);
  });

  const body = el('div', {},
    eventCtxLine,
    canPickEvent
      ? field('Event', 'Pick a live, closed or archived event to attach this expense to.', selEvent, { required: true })
      : null,
    willBePending ? el('p', { class: 'sub', style: 'margin:0 0 6px', text: '📝 Your submission goes to the committee for verification. Once verified it counts on the event dashboard.' }) : null,
    field('Amount (₹)', 'Whole rupees. This event will be debited by this amount for treasury reporting.', inpAmount, { required: true }),
    field('Category', 'Pick a preset or choose Other to type a custom category. Admins can edit the list in Settings.', el('div', {}, selCategory, inpCategoryOther), { required: true }),
    field('Description', 'A short note the treasurer will see later while auditing.', inpDescription, { info: 'Optional — you can leave this blank; useful for context.' }),
    field('Attach proof (image / PDF)', 'Committee reviews the attachment before verifying.', proofField, { info: 'Optional — image (PNG/JPEG/WebP/HEIC) or PDF up to ~700 KB.' }),
    field('Receipt / invoice URL', 'Link to the vendor invoice or paid receipt.', inpReceiptUrl, { info: 'Optional — must start with http(s):// if provided.' }),
    el('label', { class: 'row', style: 'gap:8px;margin-top:12px;cursor:pointer' }, cbVisible,
      el('span', {}, el('div', { class: 'name', text: 'Visible to residents' }),
        el('small', { class: 'sub', text: 'When ON, verified rows appear on the public expense list (subject to the society-level "residents_can_see" setting).' })
      )
    )
  );
  modal({
    title: isEdit ? 'Edit expense' : (willBePending ? 'Submit expense for verification' : 'Add expense'),
    body,
    actions: [
      { label: 'Cancel', close: true },
      { label: isEdit ? 'Save' : (willBePending ? 'Submit for verification' : 'Add expense'), kind: '', onClick: (close) => {
        const amount = Number(inpAmount.value);
        if (!(amount > 0)) { toast('Amount must be a positive number.', 'err'); return; }
        const catPick = String(selCategory.value || '').trim();
        if (!catPick) { toast('Category is required.', 'err'); return; }
        const category = catPick === '__other'
          ? String(inpCategoryOther.value || '').trim()
          : catPick;
        if (!category) { toast('Type a category name for "Other".', 'err'); return; }
        const description = String(inpDescription.value || '').trim();
        const receipt_url = String(inpReceiptUrl.value || '').trim();
        if (receipt_url && !/^https?:\/\//i.test(receipt_url)) { toast('Receipt URL must start with http(s)://', 'err'); return; }
        let eventId = evt && evt.id;
        if (canPickEvent) {
          eventId = selEvent && selEvent.value;
          if (!eventId) { toast('Pick a live event to attach this expense to.', 'err'); return; }
        }
        if (!eventId) { toast('No event context — cannot submit expense.', 'err'); return; }
        const list = state.expenses();
        const nowIso = new Date().toISOString();
        if (isEdit) {
          const rec = list.find(x => x && x.id === existing.id);
          if (rec) {
            rec.amount = amount;
            rec.category = category;
            rec.description = description;
            rec.receipt_url = receipt_url || '';
            rec.proof_data_url = proofState.data_url || '';
            rec.proof_name = proofState.name || '';
            rec.proof_size = proofState.size || 0;
            rec.visible_to_residents = !!cbVisible.checked;
            rec.updated_at = nowIso;
            state.saveExpenses(list);
            state.audit({ actor: user && user.email || null, action: 'expense.update', expense: rec.id, event: rec.event_id, amount });
            toast('Expense updated.', 'ok');
          }
        } else {
          const initialStatus = willBePending ? 'pending' : 'verified';
          const rec = {
            id: 'exp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            event_id: eventId,
            amount,
            category,
            description,
            receipt_url: receipt_url || '',
            proof_data_url: proofState.data_url || '',
            proof_name: proofState.name || '',
            proof_size: proofState.size || 0,
            visible_to_residents: !!cbVisible.checked,
            status: initialStatus,
            created_at: nowIso,
            created_by: user && (user.email || user.id) || 'unknown',
            updated_at: nowIso,
            verified_at: initialStatus === 'verified' ? nowIso : null,
            verified_by: initialStatus === 'verified' ? (user && (user.email || user.id) || 'unknown') : null,
          };
          list.push(rec);
          state.saveExpenses(list);
          state.audit({ actor: user && user.email || null, action: initialStatus === 'verified' ? 'expense.create' : 'expense.submit', expense: rec.id, event: eventId, amount });
          toast(initialStatus === 'verified' ? 'Expense recorded.' : 'Expense submitted for verification.', 'ok');
        }
        close();
        if (typeof onDone === 'function') onDone();
      } }
    ]
  });
}

function confirmDeleteExpense(r, evt, user, caps) {
  modal({
    title: 'Delete this expense?',
    body: el('p', { text: `This removes ${fmtINR(r.amount)} · ${r.category || 'expense'} from the event ledger. The audit trail keeps a record. This action cannot be undone.` }),
    actions: [
      { label: 'Cancel', close: true },
      { label: 'Delete', kind: 'btn-emerg', onClick: (close) => {
        const list = state.expenses().filter(x => x && x.id !== r.id);
        state.saveExpenses(list);
        state.audit({ actor: user && user.email || null, action: 'expense.delete', expense: r.id, event: evt.id, amount: r.amount });
        close(); toast('Expense removed.', 'ok');
        renderManage(document.getElementById('main'), evt, user, caps);
      } }
    ]
  });
}


function renderHistoryPanel(evt) {
  const rows = state.eventHistory()
    .filter(r => r && r.event === evt.id)
    .slice()
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { text: 'Moderator change history' }),
    evt.history_enabled
      ? el('p', { class: 'sub', text: 'Recorded committee/manager actions for this event.' })
      : el('p', { class: 'sub', text: 'History recording is OFF for this event. Enable it in event edit mode.' }),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'When' }),
        el('th', { text: 'Actor' }),
        el('th', { text: 'Role' }),
        el('th', { text: 'Action' }),
        el('th', { text: 'Detail' })
      )),
      el('tbody', {}, ...(rows.length
        ? rows.map(r => el('tr', {},
          el('td', { text: fmtDate(r.ts) + ' · ' + new Date(r.ts).toLocaleTimeString('en-IN', { hour12: false }) }),
          el('td', { text: r.actor || '—' }),
          el('td', { text: r.actor_role || '—' }),
          el('td', { text: r.action || '—' }),
          el('td', { text: r.detail || '' })
        ))
        : [el('tr', {}, el('td', { colspan: 5, text: 'No history records yet.', style: 'text-align:center;color:var(--muted)' }))]))
    )
  );
}

function contribRow(c, evt, user, caps) {
  const proofCell = el('td', {},
    c.ref ? el('div', { style: 'font-family:ui-monospace,monospace;font-size:12px', text: c.ref }) : el('span', { class: 'sub', text: '—' }),
    c.proof_data_url ? el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-top:4px', on: { click: () => openProof(c) } }, '🖼 View proof') : null
  );
  const tr = el('tr', {},
    el('td', { text: fmtDate(c.created_at) }),
    el('td', { text: c.anonymous ? 'Anonymous' : (c.contributor_name || '—') }),
    el('td', { text: c.anonymous ? '' : (c.flat || '') }),
    el('td', { text: c.method || '—' }),
    proofCell,
    el('td', { class: 'num', text: fmtINR(c.amount) }),
    el('td', {}, el('span', { class: 'pill ' + (c.status === 'verified' ? 'pill-sage' : c.status === 'void' ? 'pill-muted' : ''), text: c.status === 'void' ? 'invalid' : c.status })),
    el('td', {}, el('div', { class: 'row' },
      c.status === 'pending' ? el('button', { class: 'btn btn-sm', on: { click: async () => {
        try {
          const mod = await import('../events.js'); const rec = await import('../receipts.js');
          const verified = await mod.verifyContribution(c.id, user);
          await rec.attachReceipt(verified);
          toast('Verified & receipt minted', 'ok');
          renderManage(document.getElementById('main'), evt, user, caps);
        } catch (err) {
          toast((err && err.message) || 'Verify failed', 'err');
        }
      } } }, 'Verify') : null,
      c.status !== 'void' ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => {
        modal({
          title: 'Mark contribution invalid?',
          body: el('p', { text: 'This marks the record as invalid (e.g. duplicate or bad reference). The receipt (if any) will be invalidated. Use this instead of deleting so the audit trail stays intact.' }),
          actions: [
            { label: 'Cancel', close: true },
            { label: 'Mark invalid', kind: 'btn-emerg', onClick: async (close) => {
              const mod = await import('../events.js');
              mod.voidContribution(c.id, user, 'manual');
              close(); toast('Marked invalid', 'ok');
              renderManage(document.getElementById('main'), evt, user, caps);
            } }
          ]
        });
      } } }, 'Invalid') : null,
      c.receipt ? el('a', { class: 'btn btn-sm btn-ghost', href: `#/receipt/${c.id}` }, 'Receipt') : null
    ))
  );
  return tr;
}

/* Open a modal with the payment proof. Images render inline; PDFs
 * offer a "Open in new tab" link because embedding data-URL PDFs in
 * an iframe fails on most browsers by default (blocked mime handler). */
function openProof(c) {
  const isImg = /^data:image\//.test(c.proof_data_url);
  const body = el('div', {},
    el('div', { class: 'sub', style: 'margin-bottom:8px' },
      c.proof_name ? c.proof_name + ' · ' : '',
      c.proof_size ? '~' + Math.round(c.proof_size / 1024) + ' KB' : ''
    ),
    isImg
      ? el('img', { src: c.proof_data_url, alt: 'payment proof', style: 'max-width:100%;max-height:60vh;border:1px solid var(--line);border-radius:6px' })
      : el('a', { class: 'btn', href: c.proof_data_url, target: '_blank', rel: 'noopener' }, 'Open PDF in new tab')
  );
  modal({
    title: 'Payment proof · ' + (c.contributor_name || '—'),
    body,
    actions: [{ label: 'Close', close: true }]
  });
}

/* Modal viewer for an expense proof (image or PDF), mirroring
 * `openProof` for contributions. Committee uses this to review the
 * attachment before verifying the expense. */
function openExpenseProof(x) {
  const isImg = /^data:image\//.test(x.proof_data_url);
  const body = el('div', {},
    el('div', { class: 'sub', style: 'margin-bottom:8px' },
      x.proof_name ? x.proof_name + ' · ' : '',
      x.proof_size ? '~' + Math.round(x.proof_size / 1024) + ' KB' : ''
    ),
    isImg
      ? el('img', { src: x.proof_data_url, alt: 'expense proof', style: 'max-width:100%;max-height:60vh;border:1px solid var(--line);border-radius:6px' })
      : el('a', { class: 'btn', href: x.proof_data_url, target: '_blank', rel: 'noopener' }, 'Open attachment in new tab')
  );
  modal({
    title: 'Expense proof · ' + (x.category || 'expense'),
    body,
    actions: [{ label: 'Close', close: true }]
  });
}
