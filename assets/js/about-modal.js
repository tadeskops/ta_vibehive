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
    el('ul', { class: 'about-values' },
      ...ABOUT_COPY.values.map(v => el('li', { text: v }))
    ),
    el('p', { class: 'about-contact', text: 'Reach us: ' + ABOUT_COPY.contact })
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
