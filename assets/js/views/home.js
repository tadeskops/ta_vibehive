/* Landing / home view. */
'use strict';
import { el, mount, fmtINR, fmtDate, daysLeft } from '../dom.js';
import { publicEvents, totalFor, verifiedCount, STATUS } from '../events.js';
import { session } from '../auth.js';
import { navigate } from '../router.js';
import { isEventOn } from '../features.js';

export async function render(root) {
  const user = session();
  const events = publicEvents();

  const emerg = events.find(e => e.template === 'emergency' && e.status === STATUS.PUBLISHED);
  /* Belt-and-braces dedupe: publicEvents() already unique-by-id, but home
   * pulls a single emergency card into its own callout and renders the
   * rest as a grid — this filter guarantees an event never appears in
   * both the emergency callout and the grid. */
  const rest  = events.filter(e => e !== emerg && !(emerg && e.id === emerg.id));

  const hero = el('section', { class: 'hero' },
    el('div', { class: 'row row-between' },
      el('div', {},
        el('div', { class: 'pill', text: 'THE ADDRESS · BANER' }),
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

  const stats = el('div', { class: 'grid grid-4' },
    stat('Events', String(events.length), null),
    stat('Contributors', String(new Set(events.flatMap(e => contribUsers(e.id))).size), 'unique residents'),
    stat('Collected', fmtINR(events.reduce((s, e) => s + totalFor(e.id), 0)), 'across community'),
    stat('Committee', 'Cultural · Sports · Volunteers', null)
  );

  mount(root, hero, emergCard, stats, el('div', { style: 'height:8px' }), cards);
}

function stat(k, v, d) {
  return el('div', { class: 'card stat' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v }),
    d ? el('div', { class: 'd', text: d }) : null
  );
}

function contribUsers(eid) {
  return []; // preserved for future public directory
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
