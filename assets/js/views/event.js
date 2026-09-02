/* Event detail view — public read-only + admin edit tabs. */
'use strict';
import { el, mount, fmtDate, fmtINR, daysLeft, toast, modal } from '../dom.js';
import { findEvent, totalFor, verifiedCount, publicBoardFor, saveEvent, STATUS, contribsFor, canViewEventDetailedReport, nextStatusesFor, isTransitionAllowed, purgeEvent } from '../events.js';
import { catalog, isEventOn, validateEventFeatures } from '../features.js';
import { session } from '../auth.js';
import { can } from '../rbac.js';
import { navigate } from '../router.js';
import { cfg, getSociety, state } from '../store.js';
import { promptVerifyComment } from '../verify-prompt.js';
import { createExpense, verifyExpenseRemote, updateExpense, deleteExpenseRemote, deleteEventRemote, getEventQr } from '../api.js';
import { receiptDownloadIconBtn } from '../receipt-download-menu.js';
import { withSavingRing } from '../busy.js';
import { receiptWhatsAppIconBtn } from '../receipt-download-menu.js';
import { expenseDownloadIconBtn, expenseWhatsAppIconBtn } from '../receipt-download-menu.js';
import { parseFlat, validateMobile, flatRuleText } from '../validators.js';

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
        canVerify ? el('a', { class: 'btn btn-ghost', href: `#/e/${evt.id}/manage`, title: 'Verify contributions/expenses for this event, plus edit + history' }, 'Event admin') : null,
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
  const maskAmountsForResidents = await isEventOn('privacy.mask_amounts_resident', evt);
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

  const board = showBoard ? await renderPublicBoard(evt, hideAmount, user, { maskAmountsForResidents }) : null;
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

async function renderPublicBoard(evt, hideAmount, user, opts = {}) {
  const isResident = !!(user && user.role === 'resident');
  const maskAmountsForResidents = !!(opts && opts.maskAmountsForResidents);
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
          contributor_name: c.contributor_name || '',
          id: c.id,
          created_at: c.created_at || '',
          proof_data_url: c.proof_data_url || '',
          proof_archive_path: c.proof_archive_path || '',
          proof_name: c.proof_name || '',
          proof_size: c.proof_size || 0,
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
  /* Amount masking: residents see their own contribution amount but
   * other residents' amounts are blurred behind a bullet chip. The
   * committee / admin surfaces stay unaffected. */
  const shouldMaskAmount = (r) => isResident && maskAmountsForResidents && !ownsRow(r);
  const amountCell = (r) => {
    if (r.amount == null || hideAmount) return el('td', { class: 'num', text: '—' });
    if (shouldMaskAmount(r)) {
      return el('td', { class: 'num' },
        el('span', {
          class: 'tvh-amount-masked',
          title: 'Contribution amounts are masked for residents on this event.',
          'aria-label': 'Amount hidden',
        }, '•••')
      );
    }
    return el('td', { class: 'num', text: fmtINR(r.amount) });
  };
  const canViewProof = (r) => !!(user && !isResident && (r.proof_data_url || r.proof_archive_path));
  const proofIconBtn = (r) => el('button', {
    class: 'tvh-mini-icon-btn',
    type: 'button',
    title: 'View transaction receipt',
    'aria-label': 'View transaction receipt',
    on: { click: async () => { await openProof(r); } }
  }, '📎');
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
      amountCell(r),
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
              receiptWhatsAppIconBtn(r.contribId),
              receiptDownloadIconBtn(r.contribId, { title: 'Download receipt (PDF or PNG)' }),
              canViewProof(r) ? proofIconBtn(r) : null
            )
          : canDownloadOwnReceipt(r)
            ? el('span', { class: 'tvh-receipt-actions' },
              el('a', {
                class: 'tvh-mini-icon-btn',
                href: `#/receipt/${encodeURIComponent(r.contribId)}`,
                title: 'View your receipt',
                'aria-label': 'View your receipt'
              }, '👁'),
              receiptWhatsAppIconBtn(r.contribId),
              receiptDownloadIconBtn(r.contribId, { title: 'Download receipt (PDF or PNG)' })
            )
          : canViewProof(r)
            ? el('span', { class: 'tvh-receipt-actions' }, proofIconBtn(r))
            : el('small', { class: 'sub', text: '—' })
      )
    )) : [el('tr', {}, el('td', { colspan: isResident ? 5 : 6, text: 'No contributions in scope yet.', style: 'text-align:center;color:var(--muted)' }))]))
  );
  return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { text: '🌸 Contributor board' }),
    isResident && maskAmountsForResidents
      ? el('p', { class: 'sub', style: 'margin:0 0 8px', text: 'Contribution amounts are masked (•••) so residents cannot see individual amounts. Your own row shows your amount. Tally stats on top remain visible.' })
      : null,
    canReceiptDownload
      ? el('p', { class: 'sub', style: 'margin:0 0 8px', text: isResident
        ? 'Residents can download (⬇) their own verified receipts only.'
        : 'Access roles can view (👁) and download (⬇) verified receipts, and view (📎) the payment transaction attachment when the contributor uploaded one.' })
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
  // Per-event receipt theme override. Optional — when blank, society default is used.
  const RECEIPT_THEMES = [
    { id: '',                   label: '— use society default —', hint: '' },
    { id: 'default',            label: 'Default · Community Warmth',   hint: 'Warm cream + terracotta, festive vibe.' },
    { id: 'cheque-classic',     label: 'Cheque Classic · blue grid',   hint: 'Formal, treasurer-friendly ledger look.' },
    { id: 'certificate-brand',  label: 'Certificate Brand · indigo + gold', hint: 'Presentation-grade certificate for donors.' },
  ];
  const themeSel = el('select', {}, ...RECEIPT_THEMES.map(t =>
    el('option', { value: t.id, selected: (evt.receipt_theme || '') === t.id, text: t.label })
  ));
  const themeHint = el('small', { class: 'sub', style: 'display:block;margin-top:4px' });
  const themePreviewLink = el('a', {
    class: 'sub',
    href: '#',
    style: 'margin-left:8px;font-weight:600',
    text: 'Preview →'
  });
  function refreshThemeHint() {
    const found = RECEIPT_THEMES.find(t => t.id === themeSel.value) || RECEIPT_THEMES[0];
    themeHint.textContent = found.hint || 'When blank, society default receipt theme is used.';
    themePreviewLink.style.display = themeSel.value ? '' : 'none';
    themePreviewLink.setAttribute('href', 'assets/images/receipt-theme-' + (themeSel.value || 'default') + '.png');
    themePreviewLink.setAttribute('target', '_blank');
    themePreviewLink.setAttribute('rel', 'noopener');
  }
  themeSel.addEventListener('change', refreshThemeHint);
  refreshThemeHint();
  const themeI = el('div', { class: 'field' },
    el('label', { text: 'Receipt theme (optional)' }),
    themeSel,
    el('div', { class: 'row', style: 'gap:8px;align-items:baseline;margin-top:4px' }, themeHint, themePreviewLink)
  );
  // Society-records toggle. Day-to-day sports fixtures ship OFF so
  // casual play doesn't inflate the ledger; committee can flip it on
  // for e.g. an inter-society tournament that needs formal records.
  const recordsInitial = evt.records_enabled === undefined ? (evt.template !== 'sports') : !!evt.records_enabled;
  const recordsChk = el('input', { type: 'checkbox', checked: recordsInitial });
  const recordsIcon = el('span', { class: 'tvh-records-icon', 'aria-hidden': 'true' });
  const recordsHint = el('small', { class: 'sub', style: 'display:block' });
  const refreshRecords = () => {
    const on = !!recordsChk.checked;
    recordsIcon.textContent = on ? '📒' : '🚫';
    recordsHint.textContent = on
      ? 'Receipts and daily reports for this event will be archived to the private society records repo.'
      : 'This event stays off the ledger — no receipt archive, no auto-generated reports.';
  };
  recordsChk.addEventListener('change', refreshRecords);
  refreshRecords();
  const recordsI = el('div', { class: 'field' },
    el('label', { class: 'row', style: 'gap:8px;align-items:center;cursor:pointer' },
      recordsChk, recordsIcon,
      el('span', { text: 'Record this event in society ledger' })
    ),
    recordsHint
  );
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
   * preview if already saved. `remove` button clears it. The record
   * no longer carries the blob inline once archived (see worker
   * putEvent) — lazy-fetch it here so the edit form still shows a
   * preview without forcing every /events list read to decode it. */
  let qrDataUrl = evt.payment_qr_data_url || '';
  if (!qrDataUrl && evt.payment_qr_archive_path) {
    try { qrDataUrl = await getEventQr(evt.slug || evt.id); } catch (_e) { /* preview stays blank */ }
  }
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
      el('button', { class: 'btn', on: { click: async (ev) => {
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
          receipt_theme: (themeSel.value || ''),
          records_enabled: !!recordsChk.checked,
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
        const saveBtn = ev && ev.currentTarget;
        try {
          await withSavingRing(saveBtn, () => saveEvent(updated, user), { savingLabel: 'Saving…', busyLabel: 'Saving event…' });
          toast('Event saved', 'ok');
          navigate('/e/' + updated.id);
        } catch (err) {
          toast((err && err.message) || 'Could not save event', 'err');
        }
      } } }, 'Save event')
    )
  );

  form.append(el('h2', { text: 'Edit event' }),
    el('div', { class: 'grid grid-2' }, titleI, purposeI, goalI, capI, startI, endI, fixedI, suggestedI, appreciateI, themeI, recordsI),
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
    el('div', { class: 'row row-between', style: 'flex-wrap:wrap;gap:8px;align-items:flex-start' },
      el('div', { style: 'min-width:0' },
        el('h2', { text: 'Event admin · ' + evt.title }),
        el('p', { class: 'sub', text: 'Verify or mark invalid, add/edit expenses, review this event\u2019s history. For a cross-event to-do list open the Approvals inbox.' })
      ),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/manage', title: 'Open the cross-event Approvals inbox' }, '→ All approvals')
    )
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
  else sections.push(renderVerifyHistoryPanel(evt));
  // Danger zone: admins may purge a closed/archived event and every
  // record hanging off it. Never shown for active campaigns.
  if (user && user.role === 'admin' && (evt.status === STATUS.CLOSED || evt.status === STATUS.ARCHIVED)) {
    sections.push(renderDangerZone(evt, user));
  }
  mount(root, ...sections);
}

function renderDangerZone(evt, user) {
  const contribCount = state.contribs().filter(c => c && c.event === evt.id).length;
  const expenseCount = state.expenses().filter(x => x && x.event_id === evt.id).length;
  const historyCount = state.eventHistory().filter(h => h && h.event === evt.id).length;
  const wrap = el('section', { class: 'card card-pad tvh-danger-zone', style: 'margin-top:16px' });
  const title = el('h3', { style: 'margin:0;color:var(--emerg)' }, '⚠ Danger zone');
  const sub = el('p', { class: 'sub', style: 'margin:4px 0 12px' },
    `Permanently delete this ${evt.status} event and every record attached to it: `,
    el('strong', { text: `${contribCount} contribution${contribCount === 1 ? '' : 's'}, ${expenseCount} expense${expenseCount === 1 ? '' : 's'}, ${historyCount} history entr${historyCount === 1 ? 'y' : 'ies'}` }),
    ' plus matching audit rows. This cannot be undone.'
  );
  const confirmInp = el('input', {
    type: 'text',
    placeholder: `Type "${evt.title || evt.id}" to confirm`,
    autocomplete: 'off',
    style: 'width:100%;max-width:360px',
  });
  const purgeBtn = el('button', { type: 'button', class: 'btn btn-emerg', disabled: '' }, 'Purge event & all records');
  confirmInp.addEventListener('input', () => {
    const match = confirmInp.value.trim() === (evt.title || evt.id);
    if (match) purgeBtn.removeAttribute('disabled');
    else purgeBtn.setAttribute('disabled', '');
  });
  purgeBtn.addEventListener('click', async () => {
    try {
      await withSavingRing(purgeBtn, async () => {
        const res = purgeEvent(evt.id, user);
        try {
          await deleteEventRemote(evt.slug || evt.id);
        } catch (e) {
          console.warn('[event purge] server DELETE failed; blocklist keeps re-sync from resurrecting the row', e);
        }
        toast(`Purged "${res.eventTitle}" · ${res.contribs} contrib · ${res.expenses} expense · ${res.history + res.audits} log rows`, 'ok');
      }, { savingLabel: 'Purging…', busyLabel: 'Purging event…' });
      navigate('/events');
    } catch (e) {
      purgeBtn.disabled = false;
      toast((e && e.message) || 'Purge failed', 'err');
    }
  });
  wrap.append(
    title,
    sub,
    el('div', { class: 'field' },
      el('label', { text: 'Confirmation' }),
      confirmInp,
      el('small', { class: 'sub', style: 'display:block;margin-top:4px', text: 'The event id is also added to a local blocklist so the next background sync will not resurrect it from the archive repo.' })
    ),
    el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, purgeBtn)
  );
  return wrap;
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
  const canApprove = await can(user, 'expenses.approve');
  const canProcess = await can(user, 'expenses.process');
  // `expenses.verify` is retained as the umbrella capability powering
  // edit/delete/visibility affordances. Anyone who can approve OR
  // process can also perform those moderator actions.
  const canVerify = canApprove || canProcess || await can(user, 'expenses.verify');
  const rows = state.expenses().filter(x => x && x.event_id === evt.id)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const verified = rows.filter(r => r.status === 'verified');
  const pendingRows = rows.filter(r => r.status === 'pending' || r.status === 'approved' || !r.status);
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
    el('tbody', {}, ...(rows.length ? rows.map(r => expenseRow(r, evt, user, { canRecord, canVerify, canApprove, canProcess, caps })) : [
      el('tr', {}, el('td', { colspan: (canRecord || canVerify) ? 8 : 7, text: canRecord ? 'No expenses recorded yet. Tap "Add expense" to record the first one.' : 'No expenses recorded yet.', style: 'text-align:center;color:var(--muted);padding:14px' }))
    ]))
  );

  return el('section', { class: 'card', style: 'margin-top:16px;padding:0;overflow:hidden' }, head, tbl);
}

function expenseRow(r, evt, user, { canRecord, canVerify, canApprove, canProcess, caps }) {
  const isOwn = r.created_by && user && String(r.created_by).toLowerCase() === String(user.email || user.id || '').toLowerCase();
  const status = r.status || 'pending';
  const canEditThis = canRecord && (canVerify || isOwn);
  const canDeleteThis = canRecord && (canVerify || (isOwn && status !== 'verified'));
  // Voucher icons appear only for verified expenses. Residents see
  // them only on their own expense rows; treasurers/admins see them
  // on any verified expense.
  const isResidentRole = !!(user && user.role === 'resident');
  const canSeeVoucher = status === 'verified' && (canVerify || isOwn) && !(isResidentRole && !isOwn);
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
  const pillCls =
    status === 'verified' ? 'pill pill-sage'
    : status === 'approved' ? 'pill pill-warn'
    : status === 'void' ? 'pill pill-muted'
    : 'pill';
  const pillText =
    status === 'void' ? 'invalid'
    : status === 'approved' ? 'approved · awaiting payment'
    : status;
  const proofCount = Array.isArray(r.proofs)
    ? r.proofs.filter(p => p && p.data_url).length
    : (r.proof_data_url ? 1 : 0);
  return el('tr', {},
    el('td', { text: fmtDate(r.created_at) }),
    el('td', { text: r.category || '—' }),
    el('td', { style: 'max-width:280px;white-space:normal', text: (r.description || '') + (r.created_by && !canVerify ? '' : (r.created_by ? ` · by ${r.created_by}` : '')) + (r.submitter_flat || r.flat ? ` · Flat ${r.submitter_flat || r.flat}` : '') + (r.on_behalf ? ' · on behalf' : '') }),
    el('td', {}, r.receipt_url || proofCount
      ? el('div', { style: 'display:flex;flex-direction:column;gap:4px;align-items:flex-start' },
          r.receipt_url ? el('a', { class: 'btn btn-sm btn-ghost', href: r.receipt_url, target: '_blank', rel: 'noopener' }, '🔗 URL') : null,
          proofCount ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => openExpenseProof(r) } }, `🖼 View proof${proofCount > 1 ? 's (' + proofCount + ')' : ''}`) : null
        )
      : el('span', { class: 'sub', text: '—' })
    ),
    el('td', { class: 'num', text: fmtINR(r.amount) }),
    el('td', {}, el('span', { class: pillCls, text: pillText })),
    el('td', {}, visToggle),
    (canRecord || canVerify) ? el('td', {}, el('div', { class: 'row' },
      (canApprove && status === 'pending') ? el('button', { class: 'btn btn-sm', on: { click: () => approveExpense(r, evt, user, caps) } }, 'Approve') : null,
      (canProcess && status === 'approved') ? el('button', { class: 'btn btn-sm', on: { click: () => processExpense(r, evt, user, caps) } }, 'Mark processed') : null,
      canSeeVoucher ? el('a', {
        class: 'tvh-mini-icon-btn',
        href: `#/expense/${encodeURIComponent(r.id)}`,
        title: 'View expense voucher',
        'aria-label': 'View expense voucher'
      }, '👁') : null,
      canSeeVoucher ? expenseWhatsAppIconBtn(r.id) : null,
      canSeeVoucher ? expenseDownloadIconBtn(r.id, { title: 'Download expense voucher (PDF or PNG)' }) : null,
      canEditThis ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => openExpenseDialog(evt, user, r, !!r.visible_to_residents, status, () => renderManage(document.getElementById('main'), evt, user, caps)) } }, 'Edit') : null,
      canDeleteThis ? el('button', { class: 'btn btn-sm btn-ghost', on: { click: () => confirmDeleteExpense(r, evt, user, caps) } }, 'Delete') : null
    )) : null
  );
}

async function approveExpense(r, evt, user, caps) {
  const list = state.expenses();
  const rec = list.find(x => x && x.id === r.id);
  if (!rec) return;
  const subject = `${rec.category || 'Expense'} · ${fmtINR(Number(rec.amount || 0))} · ${(evt && evt.title) || ''}`;
  const comment = await promptVerifyComment({
    title: 'Approve this expense?',
    subject,
    helpText: 'Cultural Secretary approval — sanctions the spend, no receipt yet. Payment must still be made and recorded by Finance for a receipt to be generated.',
    confirmLabel: 'Approve expense',
  });
  if (comment === null) return;
  const nowIso = new Date().toISOString();
  rec.status = 'approved';
  rec.approved_at = nowIso;
  rec.approved_by = user && (user.email || user.id) || 'unknown';
  if (comment) rec.approved_comment = comment;
  rec.updated_at = nowIso;
  state.saveExpenses(list);
  state.audit({ actor: user && user.email || null, action: 'expense.approve', expense: rec.id, event: evt.id, amount: rec.amount, comment: comment || undefined });
  if (rec._path) {
    updateExpense(rec._path, {
      status: 'approved',
      approved_at: rec.approved_at,
      approved_by: rec.approved_by,
      approved_comment: rec.approved_comment || '',
    }).catch((e) => { console.warn('[expense] server approve failed; local flip stands until next sync', e); });
  }
  toast('Expense approved. Awaiting Finance to record payment.', 'ok');
  renderManage(document.getElementById('main'), evt, user, caps);
}

/* Finance mints the voucher. Optional inputs:
 *   - txn_ref (payment reference / UTR / cheque no.)
 *   - extra proof images added on top of the submitter's proofs
 *   - optional note.
 * On submit the row flips to `verified`, which is the single gate the
 * voucher view honours. */
async function processExpense(r, evt, user, caps) {
  const list = state.expenses();
  const rec = list.find(x => x && x.id === r.id);
  if (!rec) return;

  const inpTxn = el('input', { type: 'text', placeholder: 'UTR / cheque no. / UPI ref (optional)', maxlength: '64', value: rec.txn_ref || '' });
  const inpNote = el('textarea', { rows: '3', placeholder: 'Optional — payment date, mode, cross-check note…' });
  const inpProofs = el('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true });
  const proofStatus = el('div', { class: 'sub', style: 'margin-top:4px', text: 'No new payment proof attached.' });
  const proofGallery = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' });
  const extraProofs = [];

  async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('read failed'));
      fr.readAsDataURL(file);
    });
  }
  function refreshGallery() {
    proofGallery.replaceChildren(...extraProofs.map((p, idx) => {
      const box = el('div', { style: 'position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;background:#faf3ea;border:1px solid var(--muted-line,#dfd6c4)' });
      if (/^image\//i.test(p.type || '')) {
        box.appendChild(el('img', { src: p.data_url, alt: p.name || '', style: 'width:100%;height:100%;object-fit:cover;display:block' }));
      } else {
        box.appendChild(el('div', { style: 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:22px', text: '📄' }));
      }
      const rm = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', style: 'position:absolute;top:2px;right:2px;padding:0 6px;line-height:1', title: 'Remove' }, '×');
      rm.addEventListener('click', () => { extraProofs.splice(idx, 1); refreshGallery(); });
      box.appendChild(rm);
      return box;
    }));
    proofStatus.textContent = extraProofs.length
      ? `${extraProofs.length} payment proof${extraProofs.length === 1 ? '' : 's'} attached (added to any submitter proofs).`
      : 'No new payment proof attached.';
  }
  inpProofs.addEventListener('change', async () => {
    const files = Array.from(inpProofs.files || []);
    inpProofs.value = '';
    for (const f of files) {
      if (extraProofs.length >= 5) { toast('Max 5 additional proofs.', 'warn'); break; }
      if (f.size > 900 * 1024) { toast(`${f.name} is too big (>900 KB). Compress first.`, 'err'); continue; }
      try {
        const data_url = await fileToDataUrl(f);
        extraProofs.push({ data_url, name: f.name, size: f.size, type: f.type || '' });
      } catch (_e) { toast(`Could not read ${f.name}.`, 'err'); }
    }
    refreshGallery();
  });

  await new Promise((resolve) => {
    modal({
      title: 'Mark expense as processed?',
      body: el('div', {},
        el('div', { class: 'row', style: 'gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap' },
          el('small', { class: 'pill pill-muted', text: 'Expense' }),
          el('strong', { text: `${rec.category || 'Expense'} · ${fmtINR(Number(rec.amount || 0))}` })
        ),
        rec.approved_by ? el('p', { class: 'sub', style: 'margin:0 0 8px', text: `Approved by ${rec.approved_by}${rec.approved_at ? ' · ' + fmtDate(rec.approved_at) : ''}` }) : null,
        el('p', { class: 'sub', style: 'margin:0 0 10px', text: 'Recording payment mints the receipt. Voucher will be visible to the submitter and admins with access.' }),
        el('label', { class: 'lbl', text: 'Transaction reference' }),
        el('small', { class: 'sub', style: 'display:block;margin-bottom:4px', text: 'Optional. UTR, cheque number, UPI ref — whatever ties the outflow to the bank / cash book.' }),
        inpTxn,
        el('label', { class: 'lbl', style: 'margin-top:12px', text: 'Payment proof(s)' }),
        el('small', { class: 'sub', style: 'display:block;margin-bottom:4px', text: 'Optional. Screenshot of the transfer, scanned cheque, cash receipt, etc. Up to 5 files, ≤900 KB each.' }),
        inpProofs,
        proofStatus,
        proofGallery,
        el('label', { class: 'lbl', style: 'margin-top:12px', text: 'Note' }),
        el('small', { class: 'sub', style: 'display:block;margin-bottom:4px', text: 'Optional. Saved to the event history.' }),
        inpNote
      ),
      actions: [
        { label: 'Cancel', close: true, onClick: () => resolve(null) },
        { label: 'Mark processed · mint receipt', kind: '', onClick: (close) => {
          const txn = String(inpTxn.value || '').trim().slice(0, 64);
          const note = String(inpNote.value || '').trim();
          const nowIso = new Date().toISOString();
          const combinedProofs = Array.isArray(rec.proofs) ? rec.proofs.slice() : [];
          for (const p of extraProofs) combinedProofs.push({ data_url: p.data_url, name: p.name, size: p.size });
          rec.status = 'verified';
          rec.processed_at = nowIso;
          rec.processed_by = user && (user.email || user.id) || 'unknown';
          if (txn) rec.txn_ref = txn;
          if (note) rec.processed_comment = note;
          if (combinedProofs.length) {
            rec.proofs = combinedProofs.slice(0, 10);
            const legacy = combinedProofs[0] || {};
            rec.proof_data_url = legacy.data_url || rec.proof_data_url || '';
            rec.proof_name = legacy.name || rec.proof_name || '';
            rec.proof_size = legacy.size || rec.proof_size || 0;
          }
          // Backward-compat: existing consumers read verified_by / verified_at.
          rec.verified_at = nowIso;
          rec.verified_by = rec.processed_by;
          if (note) rec.verified_comment = note;
          rec.updated_at = nowIso;
          state.saveExpenses(list);
          state.audit({ actor: user && user.email || null, action: 'expense.process', expense: rec.id, event: evt.id, amount: rec.amount, comment: note || undefined, detail: txn || undefined });
          if (rec._path) {
            updateExpense(rec._path, {
              status: 'verified',
              processed_at: rec.processed_at,
              processed_by: rec.processed_by,
              processed_comment: rec.processed_comment || '',
              verified_at: rec.verified_at,
              verified_by: rec.verified_by,
              txn_ref: rec.txn_ref || '',
              proofs: rec.proofs || [],
            }).catch((e) => { console.warn('[expense] server process failed; local flip stands until next sync', e); });
          }
          toast('Payment recorded. Receipt is now available to the submitter.', 'ok');
          close();
          resolve(true);
          renderManage(document.getElementById('main'), evt, user, caps);
        } }
      ],
      onClose: () => resolve(null)
    });
  });
}

// Legacy one-click verify — kept for callers/tests still importing it.
async function verifyExpense(r, evt, user, caps) {
  return processExpense(r, evt, user, caps);
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

  /* Submitter identity — flat is the DB pivot key for every expense
   * lookup on this event. Name is required (so the treasurer can
   * reconcile without a directory lookup). Phone is optional but
   * useful when the committee needs to call the payer back for
   * clarification. When "on behalf" is ON, these fields describe the
   * beneficiary (person the payment was made FOR); the signed-in
   * user is captured as `filled_by_*`. */
  const behalfChk = el('input', { type: 'checkbox' });
  behalfChk.checked = !!(existing && existing.on_behalf);
  const inpSubmitterName = el('input', { type: 'text', maxlength: '80', required: true,
    autocomplete: 'name',
    value: existing ? (existing.submitter_name || existing.beneficiary_name || '') : (user && user.name || '') });
  const inpSubmitterFlat = el('input', { type: 'text', maxlength: '10', required: true,
    autocomplete: 'address-line2', inputmode: 'text',
    placeholder: 'e.g. A-101 or B-1305',
    value: existing ? (existing.submitter_flat || existing.flat || '') : (user && user.flat || '') });
  const inpSubmitterPhone = el('input', { type: 'tel', maxlength: '15',
    autocomplete: 'tel', inputmode: 'numeric',
    placeholder: '10-digit mobile (optional)',
    value: existing ? (existing.submitter_phone || '') : '' });
  inpSubmitterFlat.addEventListener('blur', () => {
    const parsed = parseFlat(inpSubmitterFlat.value);
    if (parsed.valid && parsed.canonical !== inpSubmitterFlat.value) {
      inpSubmitterFlat.value = parsed.canonical;
    }
  });

  /* Multi-image proof upload — up to 5 images/PDFs, each capped at
   * ~700 KB pre-base64. Stored as an array of { data_url, name, size }
   * on the expense record. Backward compatibility: reads a legacy
   * single `proof_data_url` field on load and lifts it into the
   * proofs array so old rows keep displaying. */
  const PROOF_MAX_BYTES = 900 * 1024;
  const PROOF_MAX_COUNT = 5;
  const proofs = [];
  if (existing && Array.isArray(existing.proofs) && existing.proofs.length) {
    for (const p of existing.proofs) {
      if (p && p.data_url) proofs.push({ data_url: String(p.data_url), name: String(p.name || 'proof'), size: Number(p.size || 0) });
    }
  } else if (existing && existing.proof_data_url) {
    proofs.push({ data_url: String(existing.proof_data_url), name: String(existing.proof_name || 'proof'), size: Number(existing.proof_size || 0) });
  }
  const inpProofs = el('input', {
    type: 'file', multiple: true,
    accept: 'image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,application/pdf'
  });
  const proofGallery = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px;margin-top:8px' });
  const proofStatus = el('small', { class: 'sub', style: 'display:block;margin-top:6px' });
  const refreshProofStatus = () => {
    const remaining = PROOF_MAX_COUNT - proofs.length;
    if (!proofs.length) {
      proofStatus.textContent = `Optional. Up to ${PROOF_MAX_COUNT} images / PDFs, each up to ~700 KB.`;
    } else if (remaining > 0) {
      proofStatus.textContent = `${proofs.length} attached · ${remaining} slot(s) remaining. Each up to ~700 KB.`;
    } else {
      proofStatus.textContent = `${proofs.length}/${PROOF_MAX_COUNT} attached (max). Remove one to add another.`;
    }
  };
  const rebuildGallery = () => {
    while (proofGallery.firstChild) proofGallery.removeChild(proofGallery.firstChild);
    proofs.forEach((p, i) => {
      const tile = el('div', { style: 'position:relative;border:1px solid var(--line);border-radius:6px;padding:4px;background:#fff;width:96px' });
      const isImg = /^data:image\//.test(p.data_url);
      if (isImg) {
        tile.appendChild(el('img', { src: p.data_url, alt: 'proof ' + (i + 1), style: 'width:88px;height:88px;object-fit:cover;border-radius:4px;display:block' }));
      } else {
        tile.appendChild(el('div', { style: 'width:88px;height:88px;display:flex;align-items:center;justify-content:center;background:var(--soft);border-radius:4px;font-size:22px' }, '📄'));
      }
      tile.appendChild(el('small', { class: 'sub', style: 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px', title: p.name, text: p.name || 'proof ' + (i + 1) }));
      const removeBtn = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', style: 'position:absolute;top:2px;right:2px;padding:0 6px;background:#fff;border:1px solid var(--line);border-radius:4px', 'aria-label': 'Remove proof', title: 'Remove' }, '✕');
      removeBtn.addEventListener('click', () => {
        proofs.splice(i, 1);
        rebuildGallery(); refreshProofStatus();
      });
      tile.appendChild(removeBtn);
      proofGallery.appendChild(tile);
    });
  };
  rebuildGallery(); refreshProofStatus();
  inpProofs.addEventListener('change', async () => {
    const files = Array.from(inpProofs.files || []);
    if (!files.length) return;
    let added = 0, skipped = 0, lastErr = '';
    for (const f of files) {
      if (proofs.length >= PROOF_MAX_COUNT) { skipped++; lastErr = `Max ${PROOF_MAX_COUNT} attachments — extras skipped.`; break; }
      if (f.size > PROOF_MAX_BYTES) { skipped++; lastErr = `"${f.name}" is too large (>~700 KB) — skipped.`; continue; }
      if (!/^(image\/(png|jpeg|webp|gif|heic|heif)|application\/pdf)$/i.test(f.type)) { skipped++; lastErr = `"${f.name}" type not supported — skipped.`; continue; }
      try {
        const dataUrl = await new Promise((ok, ko) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result || ''));
          r.onerror = () => ko(new Error('read failed'));
          r.readAsDataURL(f);
        });
        proofs.push({ data_url: dataUrl, name: f.name, size: f.size });
        added++;
      } catch (_e) { skipped++; lastErr = `Could not read "${f.name}".`; }
    }
    inpProofs.value = '';
    rebuildGallery(); refreshProofStatus();
    if (skipped && lastErr) toast(lastErr, added ? 'warn' : 'err');
  });
  const proofField = el('div', {}, inpProofs, proofStatus, proofGallery);

  // Field builder: shows a red asterisk on required fields; optional
  // fields carry an "info" affordance whose title reveals detail on
  // hover (desktop) or long-press (mobile — see ui.js longPressTooltip).
  const field = (label, help, ctrl, opts) => {
    const required = !!(opts && opts.required);
    const info = opts && opts.info;
    const labelEl = el('label', { class: 'lbl' },
      el('span', { class: 'field-label-text', text: label }),
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

  const filledByChip = el('div', { class: 'callout', style: 'margin-top:6px' },
    el('small', { text: 'Filed on behalf of another resident by ' }),
    el('strong', { text: (user && user.name) || (user && user.email) || 'you' }),
    el('small', { text: (user && user.flat) ? ' · Flat ' + user.flat : '' })
  );
  const nameField  = field('Name', 'Whose payment is this?', inpSubmitterName, { required: true });
  const flatField  = field('Flat number', flatRuleText(), inpSubmitterFlat, { required: true });
  const phoneField = field('Phone number', 'Optional — 10-digit mobile the committee can call back if there is a question.', inpSubmitterPhone, { info: 'Optional — leave blank if you prefer not to share.' });
  const refreshBehalfLabels = () => {
    const on = !!behalfChk.checked;
    const nameLbl = nameField.querySelector('.field-label-text');
    const flatLbl = flatField.querySelector('.field-label-text');
    const phoneLbl = phoneField.querySelector('.field-label-text');
    if (nameLbl)  nameLbl.textContent  = on ? 'Beneficiary name'  : 'Your name';
    if (flatLbl)  flatLbl.textContent  = on ? 'Beneficiary flat'  : 'Your flat number';
    if (phoneLbl) phoneLbl.textContent = on ? 'Beneficiary phone' : 'Your phone number';
    filledByChip.style.display = on ? '' : 'none';
    if (on) {
      if (inpSubmitterName.value === (user && user.name || '')) { inpSubmitterName.value = ''; }
      if (inpSubmitterFlat.value === (user && user.flat || '')) { inpSubmitterFlat.value = ''; }
    } else {
      if (!inpSubmitterName.value) inpSubmitterName.value = (user && user.name) || '';
      if (!inpSubmitterFlat.value) inpSubmitterFlat.value = (user && user.flat) || '';
    }
  };
  behalfChk.addEventListener('change', refreshBehalfLabels);

  const body = el('div', {},
    eventCtxLine,
    canPickEvent
      ? field('Event', 'Pick a live, closed or archived event to attach this expense to.', selEvent, { required: true })
      : null,
    willBePending ? el('p', { class: 'sub', style: 'margin:0 0 6px', text: '📝 Your submission goes to the committee for verification. Once verified it counts on the event dashboard.' }) : null,
    /* Submitter identity — flat is the pivot key. */
    el('label', { class: 'row', style: 'gap:8px;margin-top:10px;cursor:pointer' }, behalfChk,
      el('span', {}, el('div', { class: 'name', text: 'Submitting on behalf of another resident' }),
        el('small', { class: 'sub', text: 'Toggle ON if you paid on behalf of someone else. Fill in their flat, name and (optional) phone. Your identity is captured separately.' })
      )
    ),
    filledByChip,
    nameField,
    flatField,
    phoneField,
    field('Amount (₹)', 'Whole rupees. This event will be debited by this amount for treasury reporting.', inpAmount, { required: true }),
    field('Category', 'Pick a preset or choose Other to type a custom category. Admins can edit the list in Settings.', el('div', {}, selCategory, inpCategoryOther), { required: true }),
    field('Description', 'A short note the treasurer will see later while auditing.', inpDescription, { info: 'Optional — you can leave this blank; useful for context.' }),
    field('Attach proof (images / PDFs — up to 5)', 'Committee reviews the attachments before verifying. Multiple photos of the same receipt are welcome.', proofField, { info: 'Optional — image (PNG/JPEG/WebP/HEIC) or PDF up to ~700 KB each, max 5.' }),
    field('Receipt / invoice URL', 'Link to the vendor invoice or paid receipt.', inpReceiptUrl, { info: 'Optional — must start with http(s):// if provided.' }),
    el('label', { class: 'row', style: 'gap:8px;margin-top:12px;cursor:pointer' }, cbVisible,
      el('span', {}, el('div', { class: 'name', text: 'Visible to residents' }),
        el('small', { class: 'sub', text: 'When ON, verified rows appear on the public expense list (subject to the society-level "residents_can_see" setting).' })
      )
    )
  );
  // Set initial on-behalf labels after body is built so querySelector finds them.
  refreshBehalfLabels();
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
        const submitter_name = String(inpSubmitterName.value || '').trim();
        if (!submitter_name) { toast(behalfChk.checked ? 'Beneficiary name is required.' : 'Your name is required.', 'err'); return; }
        const flatParsed = parseFlat(inpSubmitterFlat.value);
        if (!flatParsed.valid) { toast(flatParsed.reason || 'Flat number is required.', 'err'); return; }
        const submitter_flat = flatParsed.canonical;
        inpSubmitterFlat.value = submitter_flat;
        let submitter_phone = '';
        const rawPhone = String(inpSubmitterPhone.value || '').trim();
        if (rawPhone) {
          const phCheck = validateMobile(rawPhone);
          if (!phCheck.valid) { toast(phCheck.reason || 'Phone number looks invalid.', 'err'); return; }
          submitter_phone = phCheck.digits;
        }
        let eventId = evt && evt.id;
        if (canPickEvent) {
          eventId = selEvent && selEvent.value;
          if (!eventId) { toast('Pick a live event to attach this expense to.', 'err'); return; }
        }
        if (!eventId) { toast('No event context — cannot submit expense.', 'err'); return; }
        const on_behalf = !!behalfChk.checked;
        // Snapshot proofs into an immutable array + expose legacy
        // fields for older readers that still look for proof_data_url.
        const proofsCopy = proofs.map(p => ({ data_url: p.data_url, name: p.name, size: p.size }));
        const legacyProof = proofsCopy[0] || { data_url: '', name: '', size: 0 };
        const list = state.expenses();
        const nowIso = new Date().toISOString();
        if (isEdit) {
          const rec = list.find(x => x && x.id === existing.id);
          if (rec) {
            rec.amount = amount;
            rec.category = category;
            rec.description = description;
            rec.receipt_url = receipt_url || '';
            rec.submitter_name = submitter_name;
            rec.submitter_flat = submitter_flat;
            rec.submitter_phone = submitter_phone;
            rec.flat = submitter_flat; // pivot key mirrored for query
            rec.on_behalf = on_behalf;
            rec.filled_by_email = on_behalf ? (user && user.email || null) : null;
            rec.filled_by_name  = on_behalf ? (user && user.name  || null) : null;
            rec.proofs = proofsCopy;
            rec.proof_data_url = legacyProof.data_url;
            rec.proof_name = legacyProof.name;
            rec.proof_size = legacyProof.size;
            rec.visible_to_residents = !!cbVisible.checked;
            rec.updated_at = nowIso;
            state.saveExpenses(list);
            state.audit({ actor: user && user.email || null, action: 'expense.update', expense: rec.id, event: rec.event_id, amount });
            toast('Expense updated.', 'ok');
            if (rec._path) {
              updateExpense(rec._path, {
                amount,
                category,
                description,
                receipt_url: receipt_url || '',
                submitter_name,
                submitter_flat,
                submitter_phone,
                flat: submitter_flat,
                on_behalf,
                filled_by_email: rec.filled_by_email,
                filled_by_name: rec.filled_by_name,
                proofs: proofsCopy,
                visible_to_residents: !!cbVisible.checked,
              }).catch((e) => {
                console.warn('[expense edit] server PUT failed; row will re-sync', e);
              });
            }
          }
        } else {
          const initialStatus = willBePending ? 'pending' : 'verified';
          const optimistic = {
            id: 'exp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            event_id: eventId,
            amount,
            category,
            description,
            receipt_url: receipt_url || '',
            submitter_name,
            submitter_flat,
            submitter_phone,
            flat: submitter_flat,
            on_behalf,
            filled_by_email: on_behalf ? (user && user.email || null) : null,
            filled_by_name:  on_behalf ? (user && user.name  || null) : null,
            proofs: proofsCopy,
            proof_data_url: legacyProof.data_url,
            proof_name: legacyProof.name,
            proof_size: legacyProof.size,
            visible_to_residents: !!cbVisible.checked,
            status: initialStatus,
            created_at: nowIso,
            created_by: user && (user.email || user.id) || 'unknown',
            updated_at: nowIso,
            verified_at: initialStatus === 'verified' ? nowIso : null,
            verified_by: initialStatus === 'verified' ? (user && (user.email || user.id) || 'unknown') : null,
          };
          list.push(optimistic);
          state.saveExpenses(list);
          state.audit({ actor: user && user.email || null, action: initialStatus === 'verified' ? 'expense.create' : 'expense.submit', expense: optimistic.id, event: eventId, amount });
          toast(initialStatus === 'verified' ? 'Expense recorded.' : 'Expense submitted for verification.', 'ok');
          // Fire-and-forget POST — server row is the source of truth
          // so moderators on any device see the same expense with all
          // attachments. Proofs travel too (max 5 × 700 KB) so verify
          // works end-to-end from a different device.
          createExpense({
            event_id: eventId,
            amount,
            category,
            description,
            receipt_url: receipt_url || '',
            submitter_name,
            submitter_flat,
            submitter_phone,
            flat: submitter_flat,
            on_behalf,
            filled_by_email: optimistic.filled_by_email,
            filled_by_name:  optimistic.filled_by_name,
            proofs: proofsCopy,
            visible_to_residents: !!cbVisible.checked,
            status: initialStatus,
          }).then((res) => {
            if (!res || !res.expense) return;
            const list2 = state.expenses();
            const idx = list2.findIndex((x) => x && x.id === optimistic.id);
            if (idx < 0) return;
            list2[idx] = {
              ...list2[idx],
              ...res.expense,
              _path: res.path,
              // Keep locally-decoded proof array — server may not echo
              // it back verbatim (older worker builds).
              proofs: optimistic.proofs,
              proof_data_url: optimistic.proof_data_url,
              proof_name: optimistic.proof_name,
              proof_size: optimistic.proof_size,
            };
            state.saveExpenses(list2);
          }).catch((e) => {
            console.warn('[expense] server POST failed; row stays local until next sync', e);
          });
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
        if (r._path) {
          deleteExpenseRemote(r._path).catch((e) => {
            console.warn('[expense delete] server DELETE failed; row will re-sync', e);
          });
        }
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
      ? el('p', { class: 'sub', text: 'Recorded committee/manager actions for this event. Verification actions are always logged, even when general history is off.' })
      : el('p', { class: 'sub', text: 'Only verification actions are recorded on this event. Enable "moderator history" in edit mode to log more.' }),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'When' }),
        el('th', { text: 'Actor' }),
        el('th', { text: 'Action' }),
        el('th', { text: 'Note / detail' })
      )),
      el('tbody', {}, ...(rows.length
        ? rows.map(r => renderHistoryRow(r))
        : [el('tr', {}, el('td', { colspan: 4, text: 'No history records yet.', style: 'text-align:center;color:var(--muted)' }))]))
    )
  );
}

// Verify-only history panel for viewers without events.history.view.
// Surfaces the audit trail every access-role should be able to see so
// people know who signed off on each contribution / expense.
function renderVerifyHistoryPanel(evt) {
  const rows = state.eventHistory()
    .filter(r => r && r.event === evt.id && /^(contrib|expense)\./.test(String(r.action || '')))
    .slice()
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('h3', { text: 'Verification history' }),
    el('p', { class: 'sub', text: 'Who signed off on each contribution and expense for this event, and any notes they left.' }),
    el('table', { class: 'table' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'When' }),
        el('th', { text: 'Verifier' }),
        el('th', { text: 'Action' }),
        el('th', { text: 'Note / detail' })
      )),
      el('tbody', {}, ...(rows.length
        ? rows.map(r => renderHistoryRow(r))
        : [el('tr', {}, el('td', { colspan: 4, text: 'Nothing verified yet.', style: 'text-align:center;color:var(--muted)' }))]))
    )
  );
}

function renderHistoryRow(r) {
  const parts = String(r.detail || '').split(';').filter(Boolean);
  const kv = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx > 0) kv[p.slice(0, idx).trim()] = p.slice(idx + 1);
  }
  const note = kv.note || kv.reason || '';
  const rest = parts.filter(p => !/^(note|reason)=/.test(p)).join(' · ');
  const actionLabel = {
    'contrib.verify': 'Contribution verified',
    'contrib.void':   'Contribution marked invalid',
    'expense.verify': 'Expense verified',
    'event.save':     'Event saved',
  }[r.action] || (r.action || '—');
  const when = r.ts ? (fmtDate(r.ts) + ' · ' + new Date(r.ts).toLocaleTimeString('en-IN', { hour12: false })) : '—';
  return el('tr', {},
    el('td', { text: when }),
    el('td', {},
      el('div', { style: 'font-weight:600', text: r.actor || '—' }),
      el('small', { class: 'sub', text: r.actor_role || '' })
    ),
    el('td', {}, el('span', { class: 'pill ' + (r.action === 'contrib.verify' || r.action === 'expense.verify' ? 'pill-sage' : (r.action === 'contrib.void' ? 'pill-muted' : '')), text: actionLabel })),
    el('td', {},
      note ? el('div', { style: 'font-weight:600;color:var(--ink);white-space:normal', text: '“' + note + '”' }) : null,
      rest ? el('small', { class: 'sub', style: 'display:block;font-family:ui-monospace,monospace;font-size:11px', text: rest }) : null
    )
  );
}

function contribRow(c, evt, user, caps) {
  const proofCell = el('td', {},
    c.ref ? el('div', { style: 'font-family:ui-monospace,monospace;font-size:12px', text: c.ref }) : el('span', { class: 'sub', text: '—' }),
    (c.proof_data_url || c.proof_archive_path) ? el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-top:4px', on: { click: async () => { await openProof(c); } } }, '🖼 View proof') : null
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
          const subject = `${c.contributor_name || 'Contributor'}${c.flat ? ' · Flat ' + c.flat : ''} · ${fmtINR(Number(c.amount || 0))}`;
          const comment = await promptVerifyComment({
            title: 'Verify contribution',
            subject,
            helpText: 'Optional — note anything you cross-checked (UPI reference, bank statement, cash counted…). Saved to the event history.',
            confirmLabel: 'Verify & mint receipt',
          });
          if (comment === null) return;
          const mod = await import('../events.js'); const rec = await import('../receipts.js');
          const verified = await mod.verifyContribution(c.id, user, comment);
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
 * an iframe fails on most browsers by default (blocked mime handler).
 * The record itself no longer carries the blob once archived (see
 * worker createContribution) — fetch it lazily on demand and cache
 * the result back onto `c` so re-opening doesn't refetch. */
async function openProof(c) {
  let dataUrl = c.proof_data_url;
  if (!dataUrl && (c.proof_archive_path || c.id)) {
    try {
      const { getContributionProof } = await import('../api.js');
      const res = await getContributionProof(c);
      dataUrl = res && res.proof_data_url;
      if (dataUrl) c.proof_data_url = dataUrl;
    } catch (e) {
      toast((e && e.message) || 'Could not load payment proof', 'err');
      return;
    }
  }
  if (!dataUrl) { toast('No proof attached', 'err'); return; }
  const isImg = /^data:image\//.test(dataUrl);
  const body = el('div', {},
    el('div', { class: 'sub', style: 'margin-bottom:8px' },
      c.proof_name ? c.proof_name + ' · ' : '',
      c.proof_size ? '~' + Math.round(c.proof_size / 1024) + ' KB' : ''
    ),
    isImg
      ? el('img', { src: dataUrl, alt: 'payment proof', style: 'max-width:100%;max-height:60vh;border:1px solid var(--line);border-radius:6px' })
      : el('a', { class: 'btn', href: dataUrl, target: '_blank', rel: 'noopener' }, 'Open PDF in new tab')
  );
  modal({
    title: 'Payment proof · ' + (c.contributor_name || '—'),
    body,
    actions: [{ label: 'Close', close: true }]
  });
}

/* Modal viewer for expense proof attachments (images or PDFs).
 * Handles new-style `r.proofs` array (up to 5) and legacy single
 * `proof_data_url`. Images render inline; PDFs open in a new tab
 * (data-URL PDF iframes are blocked by default in most browsers). */
function openExpenseProof(x) {
  const all = Array.isArray(x.proofs) && x.proofs.length
    ? x.proofs.filter(p => p && p.data_url)
    : (x.proof_data_url ? [{ data_url: x.proof_data_url, name: x.proof_name || '', size: x.proof_size || 0 }] : []);
  const body = el('div', {},
    el('div', { class: 'sub', style: 'margin-bottom:8px' },
      el('span', { text: `${all.length} attachment${all.length === 1 ? '' : 's'}` }),
      x.submitter_flat || x.flat ? el('span', { text: ` · Flat ${x.submitter_flat || x.flat}` }) : null,
      x.submitter_name ? el('span', { text: ` · ${x.submitter_name}` }) : null
    )
  );
  const grid = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:12px' });
  all.forEach((p, i) => {
    const isImg = /^data:image\//.test(p.data_url);
    const tile = el('div', { style: 'border:1px solid var(--line);border-radius:6px;padding:8px;background:#fff;max-width:260px' });
    tile.appendChild(el('small', { class: 'sub', style: 'display:block;margin-bottom:6px', text: (p.name || 'proof ' + (i + 1)) + (p.size ? ` · ~${Math.round(p.size / 1024)} KB` : '') }));
    if (isImg) {
      tile.appendChild(el('img', { src: p.data_url, alt: 'expense proof ' + (i + 1), style: 'max-width:100%;max-height:40vh;border-radius:4px;display:block' }));
    } else {
      tile.appendChild(el('a', { class: 'btn btn-sm', href: p.data_url, target: '_blank', rel: 'noopener' }, 'Open PDF in new tab'));
    }
    grid.appendChild(tile);
  });
  body.appendChild(grid);
  modal({
    title: 'Expense proof · ' + (x.category || 'expense'),
    body,
    actions: [{ label: 'Close', close: true }]
  });
}

export { openProof, openExpenseProof };
