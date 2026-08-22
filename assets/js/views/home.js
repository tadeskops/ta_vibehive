/* Landing / home view. */
'use strict';
import { el, mount, fmtINR, fmtDate, daysLeft } from '../dom.js';
import { publicEvents, totalFor, verifiedCount, STATUS } from '../events.js';
import { session } from '../auth.js';
import { navigate } from '../router.js';
import { isEventOn } from '../features.js';
import { getSociety, state } from '../store.js';
import { can } from '../rbac.js';

/* Options the dashboard "Latest contributions" widget offers when
 * configuring how many rows to show. Change here to expand. */
const RECENT_N_CHOICES = [5, 10, 20];

export async function render(root) {
  const user = session();
  const events = publicEvents();
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
        el('p', { class: 'sub', text: `${events.length} live event${events.length === 1 ? '' : 's'} · ${totalPublicSum(events)} raised across the community.` })
      ),
      user ? el('a', { class: 'btn btn-ghost', href: '#/events' }, '＋ Browse events') : null
    )
  );

  const emergCard = emerg ? el('div', { class: 'callout emerg' },
    el('div', { class: 'glyph', text: emerg.glyph || '🚨' }),
    el('div', { style: 'flex:1' },
      el('div', { class: 'pill', text: 'EMERGENCY · CLOSES ' + (fmtDate(emerg.end_at) || 'SOON') }),
      el('div', { class: 'lbl', text: `${emerg.title} · ${fmtINR(totalFor(emerg.id))} of ${fmtINR(emerg.goal)}` })
    ),
    el('a', { class: 'btn btn-emerg', href: `#/e/${emerg.id}` }, 'Help now')
  ) : null;

  const cards = rest.length
    ? el('div', { class: 'grid grid-3' }, ...rest.map(evt => eventCard(evt)))
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
  const stats = el('div', { class: 'grid grid-4' },
    stat('Events', String(events.length), null),
    stat('Contributors', String(contributorKeys.size), 'unique residents'),
    stat('Collected', fmtINR(events.reduce((s, e) => s + totalFor(e.id), 0)), 'across community'),
    stat('Committee', 'Cultural · Sports · Volunteers', null)
  );

  const latest = await renderLatestContribsCard(user, visibleEventIds);

  mount(root, hero, emergCard, stats, el('div', { style: 'height:8px' }), cards, latest);
}

/* Latest contributions widget. Shows the top-N most recent
 * non-void contributions across ALL events. `N` is a society-wide
 * setting (`society.dashboard.recent_n`, default 5) so it stays
 * consistent for every viewer of the dashboard. Any user with the
 * `events.create` capability (admin / mgmt / committee) can flip it
 * between the choices in `RECENT_N_CHOICES`. Anonymous / hide_amount
 * flags are honoured — the widget never leaks a name/amount the
 * contributor asked to keep private. */
async function renderLatestContribsCard(user, visibleEventIds) {
  const soc = await getSociety();
  const rawN = Number((soc.dashboard && soc.dashboard.recent_n) || RECENT_N_CHOICES[0]);
  const N = RECENT_N_CHOICES.includes(rawN) ? rawN : RECENT_N_CHOICES[0];
  const canConfigure = user ? await can(user, 'events.create') : false;

  const allEvents = state.events();
  const eventById = new Map(allEvents.map(e => [e.id, e]));
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
      return el('div', { class: 'row row-between', style: 'gap:10px;padding:10px 0;border-top:1px solid var(--line)' },
        el('div', { style: 'min-width:0;flex:1' },
          el('div', { style: 'font-weight:700', text: `${nm}${c.flat ? ' · Flat ' + c.flat : ''}` }),
          el('small', { class: 'sub', style: 'display:block', text: `${(evt && evt.title) || 'Event'} · ${fmtDate(dateShort) || dateShort}` })
        ),
        el('div', { style: 'text-align:right;flex-shrink:0' },
          el('div', { style: 'font-weight:800', text: amt }),
          el('small', { class: 'pill ' + stCls, text: c.status })
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

export function eventCard(evt) {
  const pct = evt.goal ? Math.min(100, Math.round((totalFor(evt.id) / evt.goal) * 100)) : 0;
  const dl = daysLeft(evt.end_at);
  const heroCls = 'card-hero ' + (evt.hero_class || '');
  /* Contribute is offered inline on the tile so residents don't need
   * to open the event just to give. Only shown for PUBLISHED events
   * (closed / archived events accept no more contributions). */
  const canContribute = evt.status === STATUS.PUBLISHED;
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
