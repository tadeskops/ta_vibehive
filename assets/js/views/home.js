/* Landing / home view. */
'use strict';
import { el, mount, fmtINR, fmtDate, daysLeft, toast, modal } from '../dom.js';
import { publicEvents, totalFor, verifiedCount, STATUS } from '../events.js';
import { session } from '../auth.js';
import { navigate } from '../router.js';
import { isEventOn, isSystemOn } from '../features.js';
import { getSociety, state } from '../store.js';
import { can } from '../rbac.js';
import { renderVisitCard } from '../visit-counter.js';

/* Community Warmth · v0.1 -- privacy.public_mask
 *
 * When the admin turns on `privacy.public_mask` (default OFF) and the
 * viewer is signed OUT, every financial number on the public dashboard
 * and every event card gets hidden behind a "Sign in to view" gate.
 * Specifically masked (per requirement 2026-08-22):
 *   - Hero "raised across the community" total
 *   - "Collected" KPI card + "Latest contributions" widget
 *   - Every event card's title, day + date + time, and progress amounts
 *   - Additionally, for events built from the `sports` template, the
 *     event `purpose` field (used as a venue proxy since the schema
 *     doesn't carry a first-class `venue` column yet)
 * The Contributors KPI (a count, not a rupee figure) stays visible so
 * a walk-in resident can still tell the community is active.
 *
 * Never applies to signed-in residents/committee/admins -- once you
 * log in you get the full board back. */
const MASK_LABEL = '\uD83D\uDD12 Private';
const MASK_DOTS  = '\u2022\u2022\u2022';
/**
 * Anonymous (signed-out) callers ALWAYS see the masked dashboard —
 * event tiles reveal titles + template glyphs, but every financial
 * figure, schedule detail, and contributor line stays hidden behind
 * a "sign in" gate. The old opt-in flag `privacy.public_mask` is kept
 * for backward compatibility but is now the OR side: signed-in users
 * only see masking when the admin explicitly turned it on (rare —
 * used for temporary community-warmth freeze weeks). */
export async function shouldMaskPublic(user) {
  if (!user) return true;
  try { return await isSystemOn('privacy.public_mask'); }
  catch (_e) { return false; }
}

/* Options the dashboard "Latest contributions" widget offers when
 * configuring how many rows to show. Change here to expand. */
const RECENT_N_CHOICES = [5, 10, 20];

export async function render(root) {
  const user = session();
  const events = publicEvents();
  const masked = await shouldMaskPublic(user);
  /* Society label for the hero pretitle — read live so a short_name /
   * location override in Settings reflects here on the next render.
   * Falls back to the shipped brand when the config isn't hydrated. */
  const socHero = await getSociety().catch(() => null);
  const heroBrand = socHero && socHero.short_name
    ? (String(socHero.short_name) + ((socHero.location || '').split(',')[0].trim()
        ? ' · ' + (socHero.location || '').split(',')[0].trim()
        : '')).toUpperCase()
    : 'THE ADDRESS · BANER';

  const emerg = events.find(e => e.template === 'emergency' && e.status === STATUS.PUBLISHED);
  /* Belt-and-braces dedupe: publicEvents() already unique-by-id, but home
   * pulls a single emergency card into its own callout and renders the
   * rest as a grid — this filter guarantees an event never appears in
   * both the emergency callout and the grid. */
  const rest  = events.filter(e => e !== emerg && !(emerg && e.id === emerg.id));

  const hero = el('section', { class: 'hero' },
    el('div', { class: 'row row-between' },
      el('div', {},
        el('div', { class: 'pill', text: heroBrand }),
        el('h1', { text: user ? `Namaste, ${user.name.split(' ')[0]} 🙏` : 'Welcome to VibeHive' }),
        el('p', { class: 'sub', text: masked
          ? `${events.length} live event${events.length === 1 ? '' : 's'} · ${MASK_LABEL} for community totals.`
          : `${events.length} live event${events.length === 1 ? '' : 's'} · ${totalPublicSum(events)} raised across the community.` })
      ),
      user ? el('a', { class: 'btn btn-ghost', href: '#/events' }, '＋ Browse events') : null
    )
  );

  const emergCard = emerg ? el('div', { class: 'callout emerg' },
    el('div', { class: 'glyph', text: emerg.glyph || '🚨' }),
    el('div', { style: 'flex:1' },
      el('div', { class: 'pill', text: 'EMERGENCY · CLOSES ' + (masked ? '—' : (fmtDate(emerg.end_at) || 'SOON')) }),
      el('div', { class: 'lbl', text: masked
        ? `${emerg.title} · sign in for details`
        : `${emerg.title} · ${fmtINR(totalFor(emerg.id))} of ${fmtINR(emerg.goal)}` })
    ),
    el('a', { class: 'btn btn-emerg', href: masked ? '#/login' : `#/e/${emerg.id}` }, masked ? 'Sign in' : 'Help now')
  ) : null;

  const cards = rest.length
    ? el('div', { class: 'grid grid-3' }, ...rest.map(evt => eventCard(evt, { masked })))
    : el('div', { class: 'card card-pad' },
        el('h3', { text: 'No published events yet.' }),
        el('p', { class: 'sub', text: 'Committee members can create one from the Events page.' })
      );

  /* Contributors KPI counts unique residents (by contributor id when
   * signed-in, or by "flat · name" fingerprint for anonymous / open
   * submissions) across every currently-visible event. The old code
   * relied on a `contribUsers(eid)` stub that always returned `[]`,
   * so the KPI was permanently zero even after real donations. */
  const visibleEventIds = new Set(events.map(e => e.id));
  const contributorKeys = new Set();
  for (const c of state.contribs()) {
    if (c.status === 'void') continue;
    if (!visibleEventIds.has(c.event)) continue;
    const key = c.contributor
      || `${String(c.flat || '').trim().toLowerCase()}::${String(c.contributor_name || '').trim().toLowerCase()}`;
    if (key && key !== '::') contributorKeys.add(key);
  }
  const stats = user
    ? el('div', { class: 'grid grid-4' },
      stat('Events', String(events.length), null),
      /* Contributors is a count, not a rupee figure -- kept visible even
       * when masking so an admin who briefly flips public_mask on
       * still sees community-activity signal. */
      stat('Contributors', String(contributorKeys.size), 'unique residents'),
      stat('Collected',
        masked ? MASK_LABEL : fmtINR(events.reduce((s, e) => s + totalFor(e.id), 0)),
        masked ? 'members only' : 'across community'),
      stat('Committee', 'Cultural · Sports · Volunteers', null)
    )
    /* Signed-out visitors get a lightweight two-tile summary — just
     * event count + committee label. Every rupee figure and every
     * contributor count stays behind the sign-in gate. */
    : el('div', { class: 'grid grid-2' },
      stat('Events planned', String(events.length), events.length ? 'Sign in to see schedule & finances' : 'Committee will publish soon'),
      stat('Committee', 'Cultural · Sports · Volunteers', null)
    );

  /* Signed-out users get no Latest Contributions surface at all — not
   * even a "members only" gate. The header sign-in button is the
   * single call-to-action. Signed-in residents/committee see the
   * regular widget. */
  const latest = user ? await renderLatestContribsCard(user, visibleEventIds, masked) : null;
  /* Verifier inbox — surfaces pending expenses on the dashboard for
   * anyone with `expenses.verify`. Empty state renders nothing so it
   * stays quiet for up-to-date committees. */
  const canVerifyExpense = user ? await can(user, 'expenses.verify') : false;
  const pendingExpenses = user && !masked ? renderPendingExpensesCard(user, visibleEventIds, canVerifyExpense) : null;

  /* Mobile-first daily visit tile — desktop viewers already see the
   * same figure in the footer chip so we hide this card on wide
   * screens via CSS. Renders asynchronously so the rest of the
   * dashboard paints first. */
  const visitCardWrap = el('div', { class: 'tvh-visit-card-wrap', style: 'margin-top:12px' });
  renderVisitCard(visitCardWrap).catch(() => { /* silent */ });

  mount(root, hero, emergCard, stats, el('div', { style: 'height:8px' }), cards, latest, pendingExpenses, visitCardWrap);
}

/* Latest contributions widget. Shows the top-N most recent
 * non-void contributions across ALL events. `N` is a society-wide
 * setting (`society.dashboard.recent_n`, default 5) so it stays
 * consistent for every viewer of the dashboard. Any user with the
 * `events.create` capability (admin / mgmt / committee) can flip it
 * between the choices in `RECENT_N_CHOICES`. Anonymous / hide_amount
 * flags are honoured — the widget never leaks a name/amount the
 * contributor asked to keep private. */
async function renderLatestContribsCard(user, visibleEventIds, masked) {
  const soc = await getSociety();
  const rawN = Number((soc.dashboard && soc.dashboard.recent_n) || RECENT_N_CHOICES[0]);
  const N = RECENT_N_CHOICES.includes(rawN) ? rawN : RECENT_N_CHOICES[0];
  const canConfigure = user ? await can(user, 'events.create') : false;
  const canVerifyContrib = user ? await can(user, 'contributions.verify') : false;
  const canVerifyExpense = user ? await can(user, 'expenses.verify') : false;

  /* When public-mask is on and the viewer is signed out, do not render
   * any contribution rows at all -- name + amount + event + date are
   * ALL sensitive here. A single "members only" panel replaces the
   * whole widget so the layout stays intact. */
  if (masked) {
    return el('section', { class: 'card card-pad', style: 'margin-top:16px;text-align:center' },
      el('h3', { style: 'margin:0 0 8px', text: 'Latest contributions' }),
      el('p', { class: 'sub', style: 'margin:0', text:
        MASK_LABEL + ' -- contribution details are visible to signed-in residents only.' })
    );
  }

  const allEvents = state.events();
  const eventById = new Map(allEvents.map(e => [e.id, e]));
  /* Ownership check for the row: matches the resident's own submissions
   * (contributor email/id) OR on-behalf submissions they filed. Used to
   * expose the Receipt link inline so verified contributors can grab
   * their receipt without hunting through the event page. */
  const myEmail = user && user.email ? String(user.email).toLowerCase() : '';
  const myId    = user && user.id    ? String(user.id) : '';
  const ownedByMe = (c) => {
    if (!user) return false;
    const cE  = String(c.contributor_email || '').toLowerCase();
    const cId = String(c.contributor || '').toLowerCase();
    const cCB = String(c.created_by || '').toLowerCase();
    const cFE = String(c.filled_by_email || '').toLowerCase();
    if (myEmail && (cE === myEmail || cId === myEmail || cCB === myEmail || cFE === myEmail)) return true;
    if (myId && (cId === myId.toLowerCase() || cCB === myId.toLowerCase())) return true;
    return false;
  };
  const rows = state.contribs()
    .filter(c => c.status !== 'void')
    /* Hide orphaned contributions whose event was deduped-out of the
     * dashboard (e.g. two same-slug drafts collided) — otherwise the
     * widget shows near-identical rows and confuses residents. */
    .filter(c => !visibleEventIds || visibleEventIds.has(c.event))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, N)
    .map(c => {
      const evt = eventById.get(c.event);
      const nm  = c.anonymous ? 'Anonymous' : (c.contributor_name || '—');
      const amt = c.hide_amount ? '—' : fmtINR(Number(c.amount || 0));
      const stCls = c.status === 'verified' ? 'ok' : 'warn';
      const dateShort = (c.created_at || '').slice(0, 10);
      const showReceipt = c.status === 'verified' && ownedByMe(c);
      const showVerifyIcon = canVerifyContrib && c.status === 'pending';
      return el('div', { class: 'row row-between', style: 'gap:10px;padding:10px 0;border-top:1px solid var(--line)' },
        el('div', { style: 'min-width:0;flex:1' },
          el('div', { style: 'font-weight:700', text: `${nm}${c.flat ? ' · Flat ' + c.flat : ''}` }),
          el('small', { class: 'sub', style: 'display:block', text: `${(evt && evt.title) || 'Event'} · ${fmtDate(dateShort) || dateShort}` })
        ),
        el('div', { style: 'text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px' },
          el('div', { style: 'font-weight:800', text: amt }),
          el('div', { class: 'row', style: 'gap:6px;align-items:center;justify-content:flex-end' },
            el('small', { class: 'pill ' + stCls, text: c.status }),
            showVerifyIcon ? verifyContribIconBtn(c, user, evt) : null
          ),
          showReceipt ? el('a', { class: 'btn btn-sm btn-ghost', href: `#/receipt/${c.id}`, style: 'margin-top:2px' }, '🧾 Receipt') : null
        )
      );
    });

  const chipCluster = canConfigure
    ? el('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:wrap' },
        el('small', { class: 'sub', text: 'Show top' }),
        ...RECENT_N_CHOICES.map(n => {
          const btn = el('button', {
            type: 'button',
            class: 'btn btn-sm' + (n === N ? '' : ' btn-ghost'),
            'aria-pressed': n === N ? 'true' : 'false',
            text: String(n)
          });
          btn.addEventListener('click', () => {
            const over = state.societyOverrides() || {};
            over.dashboard = { ...(over.dashboard || {}), recent_n: n };
            state.saveSocietyOverrides(over);
            state.audit({ actor: user ? user.id : null, action: 'dashboard.recent_n.set', value: n });
            /* Re-render the dashboard in place instead of a hard
             * reload so the resident's scroll position is preserved. */
            const root = document.getElementById('main');
            if (root) render(root); else location.reload();
          });
          return btn;
        })
      )
    : el('small', { class: 'sub', text: `Latest ${N}` });

  return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('div', { class: 'row row-between', style: 'align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:8px' },
      el('h3', { style: 'margin:0', text: 'Latest contributions' }),
      chipCluster
    ),
    rows.length
      ? el('div', {}, ...rows)
      : el('p', { class: 'sub', style: 'margin:8px 0 0', text: 'No contributions yet — be the first to help.' })
  );
}

function stat(k, v, d) {
  return el('div', { class: 'card stat' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v }),
    d ? el('div', { class: 'd', text: d }) : null
  );
}

/* Sleek inline verify icon button (pencil-check glyph) for the
 * dashboard widget. Kept intentionally compact so pending rows stay
 * one-line on mobile. Handler navigates through the same service
 * calls as the manage-view Verify button so the audit + receipt
 * flow is identical. Re-renders the home view in place on success. */
function verifyContribIconBtn(c, user, evt) {
  const btn = el('button', {
    type: 'button',
    class: 'tvh-verify-icon',
    'aria-label': `Verify contribution from ${c.contributor_name || 'resident'}`,
    title: 'Verify & mint receipt'
  }, '✓');
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '…';
    try {
      const [mod, rec] = await Promise.all([
        import('../events.js'),
        import('../receipts.js'),
      ]);
      const verified = await mod.verifyContribution(c.id, user);
      await rec.attachReceipt(verified);
      toast(`Verified · ${(evt && evt.title) || 'Event'} · receipt minted`, 'ok');
      /* Re-render the dashboard to reflect the new status without a
       * full reload. */
      const root = document.getElementById('main');
      if (root) render(root); else location.reload();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      toast((err && err.message) || 'Verify failed', 'err');
    }
  });
  return btn;
}

function verifyExpenseIconBtn(x, user, evt) {
  const btn = el('button', {
    type: 'button',
    class: 'tvh-verify-icon',
    'aria-label': `Verify expense from ${x.created_by || 'user'}`,
    title: 'Verify expense'
  }, '✏');
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (btn.disabled) return;
    modal({
      title: 'Verify this expense?',
      body: el('p', { text: `${x.category || 'Expense'} · ${fmtINR(x.amount)} against ${(evt && evt.title) || 'this event'}. Once verified it will count in the dashboard and reports.` }),
      actions: [
        { label: 'Cancel', close: true },
        { label: 'Verify', kind: '', onClick: (close) => {
          const list = state.expenses();
          const rec = list.find(r => r && r.id === x.id);
          if (!rec) { close(); return; }
          const nowIso = new Date().toISOString();
          rec.status = 'verified';
          rec.verified_at = nowIso;
          rec.verified_by = user && (user.email || user.id) || 'unknown';
          rec.updated_at = nowIso;
          state.saveExpenses(list);
          state.audit({ actor: user && user.email || null, action: 'expense.verify', expense: rec.id, event: rec.event_id, amount: rec.amount });
          close(); toast('Expense verified.', 'ok');
          const root = document.getElementById('main');
          if (root) render(root); else location.reload();
        } }
      ]
    });
  });
  return btn;
}

/* Pending-expenses inbox — surfaced on the dashboard for verifiers so
 * they don't need to open each event's manage view to clear backlog.
 * Empty state (no pending rows) renders nothing so it stays quiet for
 * committees who are up-to-date. */
function renderPendingExpensesCard(user, visibleEventIds, canVerifyExpense) {
  if (!canVerifyExpense) return null;
  const eventById = new Map(state.events().map(e => [e.id, e]));
  const pending = state.expenses()
    .filter(x => x && (x.status === 'pending' || !x.status))
    .filter(x => !visibleEventIds || visibleEventIds.has(x.event_id))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!pending.length) return null;
  const rows = pending.map(x => {
    const evt = eventById.get(x.event_id);
    return el('div', { class: 'row row-between', style: 'gap:10px;padding:10px 0;border-top:1px solid var(--line)' },
      el('div', { style: 'min-width:0;flex:1' },
        el('div', { style: 'font-weight:700', text: `${x.category || 'Expense'}${x.created_by ? ' · ' + x.created_by : ''}` }),
        el('small', { class: 'sub', style: 'display:block', text: `${(evt && evt.title) || 'Event'} · ${fmtDate((x.created_at || '').slice(0, 10)) || ''}${x.description ? ' · ' + x.description : ''}` })
      ),
      el('div', { style: 'text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px' },
        el('div', { style: 'font-weight:800', text: fmtINR(x.amount) }),
        el('div', { class: 'row', style: 'gap:6px;align-items:center;justify-content:flex-end' },
          el('small', { class: 'pill', text: 'pending' }),
          verifyExpenseIconBtn(x, user, evt)
        )
      )
    );
  });
  const totalPending = pending.reduce((s, x) => s + Number(x.amount || 0), 0);
  return el('section', { class: 'card card-pad', style: 'margin-top:16px' },
    el('div', { class: 'row row-between', style: 'align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:8px' },
      el('h3', { style: 'margin:0', text: 'Expenses awaiting your verify' }),
      el('small', { class: 'sub', text: `${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} · ${fmtINR(totalPending)} queued` })
    ),
    el('div', {}, ...rows)
  );
}

function contribUsers(_eid) {
  /* Deprecated. Contributors are counted directly in `render()` using
   * `state.contribs()` cross-referenced with visible event IDs; kept
   * only so any lingering imports don't throw. */
  return [];
}

function totalPublicSum(events) {
  const sum = events.reduce((s, e) => s + totalFor(e.id), 0);
  return fmtINR(sum);
}

export function eventCard(evt, opts) {
  const masked = !!(opts && opts.masked);
  const pct = evt.goal ? Math.min(100, Math.round((totalFor(evt.id) / evt.goal) * 100)) : 0;
  const dl = daysLeft(evt.end_at);
  const heroCls = 'card-hero ' + (evt.hero_class || '');
  const canContribute = evt.status === STATUS.PUBLISHED && !masked;
  /* Anonymous / masked view: keep the tile lightweight — only the
   * template glyph, event title, and a single "sign in to see
   * schedule + finances" gate. No rupee figures, no contributor
   * count, no dates. Signed-in users get the full progress card. */
  if (masked) {
    return el('article', { class: 'card' },
      el('div', { class: heroCls.trim() },
        el('span', { class: 'badge', text: evt.glyph + ' ' + (evt.template || 'event') }),
        el('span', { class: 'glyph', text: evt.glyph || '' })
      ),
      el('div', { class: 'card-content' },
        el('h3', { class: 'card-title', text: evt.title || 'Community event' }),
        el('p', { class: 'card-sub', text: 'Planned by the committee.' }),
        el('div', { class: 'row row-between', style: 'margin-top:10px;flex-wrap:wrap;gap:8px' },
          el('span', { class: 'card-sub', style: 'margin:0', text: '🔒 Sign in for schedule & finances' }),
          el('a', { class: 'btn btn-sm', href: '#/login' }, 'Sign in')
        )
      )
    );
  }
  return el('article', { class: 'card' },
    el('div', { class: heroCls.trim() },
      el('span', { class: 'badge', text: evt.glyph + ' ' + (evt.template || 'event') }),
      el('span', { class: 'glyph', text: evt.glyph || '' })
    ),
    el('div', { class: 'card-content' },
      el('h3', { class: 'card-title', text: evt.title }),
      el('p', { class: 'card-sub', text: evt.purpose || 'Community event' }),
      evt.goal ? el('div', {},
        el('div', { class: 'progress' + (evt.hero_class === 'sage' ? ' sage' : evt.hero_class === 'gold' ? ' gold' : '') }, el('i', { style: { width: pct + '%' } })),
        el('div', { class: 'progress-meta' },
          el('span', { text: `${fmtINR(totalFor(evt.id))} of ${fmtINR(evt.goal)}` }),
          el('span', { text: `${verifiedCount(evt.id)} contributors` })
        )
      ) : el('div', { class: 'progress-meta', style: 'margin-top:8px' },
        el('span', { text: `${fmtINR(totalFor(evt.id))} collected` }),
        el('span', { text: `${verifiedCount(evt.id)} contributors` })
      ),
      el('div', { class: 'row row-between', style: 'margin-top:12px;flex-wrap:wrap;gap:8px' },
        el('span', { class: 'card-sub', style: 'margin:0', text: dl != null ? (dl > 0 ? `${dl} day${dl === 1 ? '' : 's'} left` : 'Closes today') : (evt.start_at ? 'Starts ' + fmtDate(evt.start_at) : '') }),
        el('div', { class: 'row', style: 'gap:6px' },
          el('a', { class: 'btn btn-sm btn-ghost', href: `#/e/${evt.id}` }, 'View'),
          canContribute ? el('a', { class: 'btn btn-sm', href: `#/e/${evt.id}/contribute` }, '＋ Contribute') : null
        )
      )
    )
  );
}
