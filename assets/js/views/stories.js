/* Stories · composer + management view.
 *
 * Route: `#/stories` (list active + archived, committee+ only).
 * `#/stories/new` opens the composer inline.
 *
 * Composer flow:
 *   1. Pick an image (file input, camera-capable on mobile).
 *   2. resizeStoryImage() shrinks it in the browser to 1080x1920 JPEG
 *      + 96x160 thumb so POST bodies stay small.
 *   3. Fill title, expiry days, and contact CTA (WhatsApp / call /
 *      link). Preview the ring on the right.
 *   4. Publish -> POST /stories -> toast + navigate back to #/.
 *
 * The list below the composer shows every story we have locally,
 * grouped by active / archived, with archive + delete actions. */
'use strict';
import { el, mount, toast, fmtDate } from '../dom.js';
import { session } from '../auth.js';
import { navigate } from '../router.js';
import { can } from '../rbac.js';
import { state } from '../store.js';
import { withSavingRing } from '../busy.js';
import { isSystemOn } from '../features.js';
import { activeStories, isExpired, resizeStoryImage, storyPathParts } from '../stories.js';
import { createStory, archiveStoryRemote, deleteStoryRemote, listStories } from '../api.js';

const DEFAULT_EXPIRY_DAYS = 7;

async function refreshLocalStories() {
  try {
    const remote = await listStories();
    if (Array.isArray(remote)) state.saveStories(remote);
  } catch (_e) { /* keep local cache */ }
}

export async function render(root) {
  const user = session();
  if (!user) { navigate('/login'); return; }
  let enabled = false;
  try { enabled = await isSystemOn('stories.enabled'); } catch (_e) { enabled = false; }
  const canCreate = await can(user, 'stories.create');
  const canArchive = await can(user, 'stories.archive');
  const canDelete = await can(user, 'stories.delete');
  if (!enabled) {
    mount(root, el('section', { class: 'card card-pad' },
      el('h2', { text: 'Dashboard stories' }),
      el('p', { class: 'sub', text: 'Stories are currently turned off. Ask an admin to enable "Dashboard stories" from the Feature registry to publish or manage announcements.' }),
      el('a', { class: 'btn btn-ghost', href: '#/', style: 'margin-top:12px' }, 'Back to home'),
    ));
    return;
  }
  if (!canCreate && !canArchive) {
    mount(root, el('section', { class: 'card card-pad' },
      el('h2', { text: 'Stories' }),
      el('p', { class: 'sub', text: 'You do not have permission to manage dashboard stories.' }),
    ));
    return;
  }

  const wantsCompose = /\/stories\/new/.test(location.hash);
  const stories = state.stories() || [];

  const header = el('div', { class: 'row row-between', style: 'align-items:center;flex-wrap:wrap;gap:12px' },
    el('div', {},
      el('h2', { text: 'Dashboard stories', style: 'margin:0' }),
      el('p', { class: 'sub', style: 'margin:4px 0 0', text: 'Instagram-style announcements pinned above the hero. Auto-expire.' }),
    ),
    canCreate && !wantsCompose ? el('button', { class: 'btn', on: { click: () => navigate('/stories/new') } }, '+ New story') : null,
    canCreate && wantsCompose ? el('button', { class: 'btn btn-ghost', on: { click: () => navigate('/stories') } }, 'Cancel') : null,
  );

  const composer = canCreate && wantsCompose ? renderComposer(user) : null;
  const list = renderList(stories, { canArchive, canDelete });

  mount(root, el('section', { class: 'card card-pad' }, header), composer, list);
}

function renderComposer(user) {
  const draft = {
    title: '',
    fullDataUrl: '',
    thumbDataUrl: '',
    fileName: '',
    fileSize: 0,
    ctaKind: 'whatsapp',
    ctaLabel: '',
    ctaValue: '',
    ctaPrefill: '',
    expiryDays: DEFAULT_EXPIRY_DAYS,
    durationMs: 6000,
  };

  const preview = el('div', { class: 'tvh-story-preview' },
    el('div', { class: 'tvh-story-ring lg placeholder' }, '＋'),
    el('div', { class: 'sub', style: 'margin-top:8px;text-align:center', text: 'Preview' }),
  );

  function refreshPreview() {
    while (preview.firstChild) preview.removeChild(preview.firstChild);
    const ring = el('div', { class: 'tvh-story-ring lg' + (draft.thumbDataUrl ? '' : ' placeholder') });
    if (draft.thumbDataUrl) {
      ring.append(el('img', { src: draft.thumbDataUrl, alt: draft.title || 'story thumbnail' }));
    } else {
      ring.textContent = '＋';
    }
    preview.append(ring);
    preview.append(el('div', { class: 'sub', style: 'margin-top:8px;text-align:center;max-width:120px', text: draft.title || 'Untitled' }));
  }
  refreshPreview();

  const fileInput = el('input', {
    type: 'file',
    // `image/*` (not a narrow allow-list) lets iOS Safari and Android
    // Chrome offer "Photo Library / Take Photo / Choose File" -- narrowing
    // to specific MIMEs suppresses the camera option on some builds.
    accept: 'image/*',
    style: 'display:block;margin-top:6px',
    on: {
      change: async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        if (f.size > 8 * 1024 * 1024) return toast('Image is over 8 MB — pick a smaller file.', 'err');
        try {
          const { full, thumb } = await resizeStoryImage(f);
          draft.fullDataUrl = full;
          draft.thumbDataUrl = thumb;
          draft.fileName = f.name;
          draft.fileSize = full.length;
          refreshPreview();
          toast('Image ready · ' + Math.round(full.length / 1024) + ' KB', 'ok');
        } catch (_e) {
          toast('Could not read image. Try a PNG or JPEG.', 'err');
        }
      },
    },
  });

  const titleInput = el('input', {
    type: 'text',
    maxLength: 60,
    placeholder: 'Short announcement title',
    on: { input: (e) => { draft.title = e.target.value; refreshPreview(); } },
  });
  const ctaKindSel = el('select', {
    on: { change: (e) => { draft.ctaKind = e.target.value; } },
  },
    el('option', { value: 'whatsapp' }, 'WhatsApp message'),
    el('option', { value: 'tel' }, 'Phone call'),
    el('option', { value: 'link' }, 'External link'),
  );
  const ctaValueInput = el('input', {
    type: 'text',
    placeholder: 'Phone number or URL',
    on: { input: (e) => { draft.ctaValue = e.target.value; } },
  });
  const ctaLabelInput = el('input', {
    type: 'text',
    maxLength: 40,
    placeholder: 'Button label (e.g. Sign up)',
    on: { input: (e) => { draft.ctaLabel = e.target.value; } },
  });
  const ctaPrefillInput = el('textarea', {
    rows: 2,
    maxLength: 300,
    placeholder: 'Optional message pre-filled in WhatsApp',
    on: { input: (e) => { draft.ctaPrefill = e.target.value; } },
  });
  const expiryDaysInput = el('input', {
    type: 'number',
    min: '1',
    max: '60',
    value: String(DEFAULT_EXPIRY_DAYS),
    on: { input: (e) => { draft.expiryDays = Math.max(1, Math.min(60, Number(e.target.value) || DEFAULT_EXPIRY_DAYS)); } },
  });
  const durationInput = el('input', {
    type: 'number',
    min: '2',
    max: '30',
    step: '1',
    value: '6',
    on: { input: (e) => { draft.durationMs = Math.max(2, Math.min(30, Number(e.target.value) || 6)) * 1000; } },
  });

  const publish = el('button', { class: 'btn btn-block', on: { click: async (ev) => {
    if (!draft.title.trim()) return toast('Title is required', 'err');
    if (!draft.thumbDataUrl) return toast('Pick an image first', 'err');
    const expiresAt = new Date(Date.now() + draft.expiryDays * 86400_000).toISOString();
    const ctaValue = draft.ctaValue.trim();
    const payload = {
      title: draft.title.trim(),
      thumb_data_url: draft.thumbDataUrl,
      image_data_url: draft.fullDataUrl,
      expires_at: expiresAt,
      duration_ms: draft.durationMs,
    };
    if (ctaValue) {
      payload.cta_kind = draft.ctaKind;
      payload.cta_value = ctaValue;
      const label = draft.ctaLabel.trim();
      const prefill = draft.ctaPrefill.trim();
      if (label) payload.cta_label = label;
      if (prefill) payload.cta_prefill = prefill;
    }
    try {
      await withSavingRing(ev && ev.currentTarget, () => createStory(payload), { savingLabel: 'Publishing…', busyLabel: 'Publishing story…' });
    } catch (e) {
      return toast(e.message || 'Could not publish story', 'err');
    }
    await refreshLocalStories();
    toast('Story published', 'ok');
    navigate('/');
  } } }, 'Publish story');

  return el('section', { class: 'card card-pad tvh-story-composer', style: 'margin-top:12px' },
    el('h3', { text: 'New story' }),
    el('p', { class: 'sub', text: 'Best fit: a portrait poster (9:16). We resize to 1080×1920 automatically.' }),
    el('div', { class: 'grid tvh-story-composer-grid', style: 'gap:16px;align-items:flex-start' },
      el('div', {},
        field('Poster image *', fileInput, 'PNG / JPEG / WebP up to 8 MB. Camera capture supported on mobile.'),
        field('Title *', titleInput),
        el('div', { class: 'grid grid-2', style: 'gap:12px' },
          field('Expires in (days)', expiryDaysInput),
          field('Frame duration (seconds)', durationInput, 'How long the story lingers before advancing.'),
        ),
        el('h4', { style: 'margin:16px 0 4px', text: 'Contact CTA (optional)' }),
        el('p', { class: 'sub', style: 'margin:0 0 8px', text: 'Leave the value blank to publish a pure announcement with no button.' }),
        el('div', { class: 'grid grid-2', style: 'gap:12px' },
          field('Kind', ctaKindSel),
          field('Value', ctaValueInput, 'Phone with country code, or a full URL.'),
        ),
        field('Button label', ctaLabelInput, 'Overrides the default "Message on WhatsApp".'),
        field('Prefill message (WhatsApp only)', ctaPrefillInput),
        el('div', { style: 'margin-top:16px' }, publish),
      ),
      preview,
    ),
  );
}

function field(label, input, hint) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    input,
    hint ? el('small', { class: 'sub', text: hint }) : null,
  );
}

function renderList(stories, { canArchive, canDelete }) {
  const active = activeStories(stories);
  const inactive = stories.filter((s) => s && (s.status !== 'active' || isExpired(s)));

  const section = (title, rows, emptyMsg) => el('section', { class: 'card card-pad', style: 'margin-top:12px' },
    el('h3', { text: title + ' · ' + rows.length }),
    rows.length ? el('div', { class: 'grid grid-3', style: 'gap:12px' }, ...rows.map((s) => renderCard(s, { canArchive, canDelete })))
      : el('p', { class: 'sub', text: emptyMsg }),
  );

  return el('div', {},
    section('Live on dashboard', active, 'No active stories. Publish one above to pin an announcement.'),
    section('Archived / expired', inactive, 'Archived stories will show up here.'),
  );
}

function renderCard(story, { canArchive, canDelete }) {
  const parts = storyPathParts(story);
  const expiresText = story.expires_at ? ('Expires ' + fmtDate(story.expires_at)) : '';
  const statusPill = el('span', { class: 'pill', text: (story.status || '') + (isExpired(story) ? ' · expired' : '') });
  const archiveBtn = canArchive && story.status === 'active' ? el('button', {
    class: 'btn btn-ghost',
    on: { click: async () => {
      try {
        await archiveStoryRemote(parts.year, parts.month, parts.id);
      } catch (e) { return toast(e.message || 'Could not archive', 'err'); }
      await refreshLocalStories();
      toast('Story archived', 'ok');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } },
  }, 'Archive') : null;
  const deleteBtn = canDelete ? el('button', {
    class: 'btn btn-danger',
    on: { click: async () => {
      if (!confirm('Delete this story permanently? This cannot be undone.')) return;
      try {
        await deleteStoryRemote(parts.year, parts.month, parts.id);
      } catch (e) { return toast(e.message || 'Could not delete', 'err'); }
      await refreshLocalStories();
      toast('Story deleted', 'ok');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } },
  }, 'Delete') : null;

  return el('article', { class: 'card card-pad tvh-story-card' },
    el('div', { style: 'display:flex;gap:12px;align-items:flex-start' },
      el('div', { class: 'tvh-story-ring md' },
        story.thumb_data_url ? el('img', { src: story.thumb_data_url, alt: story.title || 'story' }) : null,
      ),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'lbl', text: story.title || 'Untitled' }),
        el('div', { class: 'sub', text: expiresText }),
        statusPill,
      ),
    ),
    el('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' }, archiveBtn, deleteBtn),
  );
}
