/* Fullscreen story viewer overlay.
 *
 * Instagram-style presentation: single frame at a time, auto-advance
 * progress bar per story, tap left/right to navigate, tap outside to
 * dismiss, CTA button at the bottom that opens WhatsApp / phone dialer
 * / external link built from the story's contact fields.
 *
 * The list handed in has thumbnails only (that's what /stories returns
 * in bulk). The first render shows the thumb immediately, then the
 * viewer fetches the full-res image_data_url in the background and
 * swaps it in. This keeps the tap-to-open animation instant on mobile.
 */
'use strict';
import { el } from './dom.js';
import { ctaHref, storyPathParts } from './stories.js';
import { readStory } from './api.js';

/**
 * Open the viewer at `startIndex` inside `stories`. Returns { close }
 * so the caller can programmatically dismiss (e.g. on route change).
 */
export function openStoryViewer(stories, startIndex = 0) {
  const list = Array.isArray(stories) ? stories.filter(Boolean) : [];
  if (!list.length) return { close: () => {} };
  const back = el('div', { class: 'tvh-story-viewer', role: 'dialog', 'aria-modal': 'true' });
  let idx = Math.max(0, Math.min(startIndex | 0, list.length - 1));
  let timer = null;
  let startedAt = 0;
  let elapsed = 0;
  let paused = false;
  const imageCache = new Map();

  const close = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    back.remove();
    document.removeEventListener('keydown', onKey);
  };

  const goTo = (next) => {
    if (next < 0) { close(); return; }
    if (next >= list.length) { close(); return; }
    idx = next;
    elapsed = 0;
    render();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') goTo(idx + 1);
    else if (e.key === 'ArrowLeft') goTo(idx - 1);
  };
  document.addEventListener('keydown', onKey);

  back.addEventListener('click', (e) => { if (e.target === back) close(); });

  async function ensureFullImage(story) {
    if (!story) return null;
    if (story.image_data_url) return story.image_data_url;
    if (imageCache.has(story.id)) return imageCache.get(story.id);
    const parts = storyPathParts(story);
    if (!parts) return story.thumb_data_url;
    try {
      const full = await readStory(parts.year, parts.month, parts.id);
      const url = (full && full.image_data_url) || story.thumb_data_url;
      imageCache.set(story.id, url);
      return url;
    } catch (_e) {
      return story.thumb_data_url;
    }
  }

  function render() {
    const story = list[idx];
    const duration = Math.max(2000, Math.min(30000, Number(story.duration_ms) || 6000));
    while (back.firstChild) back.removeChild(back.firstChild);

    // Progress bar row (one segment per story).
    const bars = el('div', { class: 'tvh-story-bars' },
      ...list.map((_, i) => {
        const seg = el('div', { class: 'tvh-story-bar' });
        const fill = el('div', {
          class: 'tvh-story-bar-fill' + (i < idx ? ' done' : i === idx ? ' active' : ''),
          style: i === idx ? { animationDuration: duration + 'ms' } : null,
        });
        seg.append(fill);
        return seg;
      }),
    );

    const header = el('div', { class: 'tvh-story-head' },
      el('div', { class: 'tvh-story-title', text: story.title || '' }),
      el('button', {
        class: 'tvh-story-close',
        'aria-label': 'Close stories',
        on: { click: close },
      }, '×'),
    );

    const img = el('img', {
      class: 'tvh-story-img',
      alt: story.title || 'Story',
      src: story.thumb_data_url || '',
    });
    ensureFullImage(story).then((url) => {
      if (url && img.isConnected) img.src = url;
    });

    // Left / right tap zones for prev/next navigation.
    const prevTap = el('div', { class: 'tvh-story-tap prev', on: { click: () => goTo(idx - 1) } });
    const nextTap = el('div', { class: 'tvh-story-tap next', on: { click: () => goTo(idx + 1) } });

    const href = ctaHref(story);
    const ctaLabel = story.cta_label
      || (story.cta_kind === 'whatsapp' ? 'Message on WhatsApp'
        : story.cta_kind === 'tel' ? 'Call now'
        : story.cta_kind === 'link' ? 'Open link'
        : null);
    const cta = href && ctaLabel ? el('a', {
      class: 'tvh-story-cta',
      href,
      target: story.cta_kind === 'link' ? '_blank' : null,
      rel: story.cta_kind === 'link' ? 'noopener noreferrer' : null,
    }, ctaLabel) : null;

    const stage = el('div', { class: 'tvh-story-stage' }, img, prevTap, nextTap);
    back.append(bars, header, stage, cta || el('div', { class: 'tvh-story-cta-spacer' }));

    // Pause on pointer-down anywhere in the stage, resume on release —
    // matches the IG behaviour so a moderator can hold to read a busy
    // poster without the frame auto-advancing.
    stage.addEventListener('pointerdown', () => { paused = true; pause(); });
    stage.addEventListener('pointerup', () => { paused = false; resume(); });
    stage.addEventListener('pointerleave', () => { if (paused) { paused = false; resume(); } });

    startedAt = Date.now();
    scheduleAdvance(duration - elapsed);
  }

  function pause() {
    if (!timer) return;
    clearTimeout(timer); timer = null;
    elapsed += Date.now() - startedAt;
    const bar = back.querySelector('.tvh-story-bar-fill.active');
    if (bar) bar.style.animationPlayState = 'paused';
  }
  function resume() {
    if (timer) return;
    startedAt = Date.now();
    const story = list[idx];
    const duration = Math.max(2000, Math.min(30000, Number(story.duration_ms) || 6000));
    const bar = back.querySelector('.tvh-story-bar-fill.active');
    if (bar) bar.style.animationPlayState = 'running';
    scheduleAdvance(Math.max(500, duration - elapsed));
  }
  function scheduleAdvance(ms) {
    timer = setTimeout(() => { timer = null; goTo(idx + 1); }, Math.max(500, ms | 0));
  }

  document.body.append(back);
  render();
  return { close };
}
