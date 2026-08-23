/* About modal — minimalist attribution surface for Samana Sippa Labs.
 * Kept intentionally lightweight; no external assets. Extend the
 * ABOUT_COPY block when you're ready to add more detail.
 */
'use strict';
import { modal, el } from './dom.js';

const ABOUT_COPY = {
  brand: 'Samana Sippa Labs',
  tagline: 'Small, warm software for communities.',
  intro: 'VibeHive is built by Samana Sippa Labs — a home grown studio focused on quiet, dependable tools that let neighbours celebrate together and keep books clean without spreadsheets.',
  belief: 'We believe meaningful innovation comes from curiosity, disciplined inquiry, continuous learning, and skilled creation.',
  pillarsHeading: 'Our core pillars',
  pillars: [
    { name: 'Question',            desc: 'Challenge assumptions and explore beyond the obvious.' },
    { name: 'Investigate',         desc: 'Observe, research, experiment, and seek evidence.' },
    { name: 'Learn',               desc: 'Treat knowledge and failure as opportunities for growth.' },
    { name: 'Build',               desc: 'Transform ideas and knowledge into practical solutions.' },
    { name: 'Refine',              desc: 'Continuously improve through testing, feedback, and iteration.' },
    { name: 'Create with Purpose', desc: 'Develop technology that is useful, responsible, and meaningful.' },
  ],
  principle: 'Question deeply. Learn continuously. Build skillfully. Improve relentlessly.',
  values: [
    'Every rupee is receipted with a tamper-evident hash.',
    'Zero third-party trackers. Your data lives in your own private repo.',
    'Everything is configuration — nothing hard-coded for one society.',
  ],
  contact: 'samanasippa@gmail.com',
};

export function openAboutModal() {
  const body = el('div', { class: 'about-modal-body' },
    el('div', { class: 'about-brand' },
      el('span', { class: 'about-bee', 'aria-hidden': 'true', text: '🐝' }),
      el('div', {},
        el('div', { class: 'about-title', text: ABOUT_COPY.brand }),
        el('div', { class: 'about-tag', text: ABOUT_COPY.tagline })
      )
    ),
    el('p', { class: 'about-intro', text: ABOUT_COPY.intro }),
    el('p', { class: 'about-belief', style: 'font-style:italic;color:var(--muted);margin-top:10px', text: ABOUT_COPY.belief }),
    el('h4', { class: 'about-heading', style: 'margin:14px 0 6px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--terra)', text: ABOUT_COPY.pillarsHeading }),
    el('ol', { class: 'about-pillars', style: 'margin:0;padding-left:20px' },
      ...ABOUT_COPY.pillars.map((p) => el('li', { style: 'margin:6px 0' },
        el('b', { text: p.name }),
        el('span', { text: ' — ' + p.desc })
      ))
    ),
    el('blockquote', { class: 'about-principle', style: 'margin:14px 0 8px;padding:10px 14px;border-left:3px solid var(--terra);background:var(--terra-soft);border-radius:0 8px 8px 0;font-weight:600' }, ABOUT_COPY.principle),
    el('h4', { class: 'about-heading', style: 'margin:14px 0 6px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--terra)', text: 'How VibeHive lives it' }),
    el('ul', { class: 'about-values' },
      ...ABOUT_COPY.values.map(v => el('li', { text: v }))
    ),
    el('p', { class: 'about-contact', style: 'margin-top:12px', text: 'Reach us: ' + ABOUT_COPY.contact })
  );
  modal({
    title: 'About VibeHive',
    body,
    actions: [{ label: 'Close', close: true }],
  });
}

export function wireAboutTriggers() {
  const triggers = ['#footpad-about', '#brand-tooltip-about'];
  for (const sel of triggers) {
    const btn = document.querySelector(sel);
    if (!btn || btn.dataset._tvhAboutWired === '1') continue;
    btn.dataset._tvhAboutWired = '1';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openAboutModal();
    });
  }
}
