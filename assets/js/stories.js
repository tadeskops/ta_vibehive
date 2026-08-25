/* Story helpers — dashboard announcements ("Instagram-style" surface).
 *
 * Shared between the ring strip on home, the fullscreen viewer overlay,
 * and the composer / management view. Kept side-effect-free so any
 * caller can import without triggering a network fetch. */
'use strict';

/** True when the story has an expires_at in the past. */
export function isExpired(story) {
  if (!story || !story.expires_at) return false;
  return new Date(story.expires_at).getTime() <= Date.now();
}

/** Currently-visible stories: status active AND not expired. Callers
 *  should treat this as the source of truth (the server also filters,
 *  but the client re-checks so an expiry that ticked over between
 *  syncs is respected immediately). */
export function activeStories(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && s.status === 'active' && !isExpired(s));
}

/** Build a tap-target href for a story's contact CTA. */
export function ctaHref(story) {
  if (!story || !story.cta_kind || !story.cta_value) return null;
  const value = String(story.cta_value).trim();
  const prefill = String(story.cta_prefill || '').trim();
  if (story.cta_kind === 'whatsapp') {
    const digits = value.replace(/[^0-9+]/g, '').replace(/^\+/, '');
    const text = prefill ? '?text=' + encodeURIComponent(prefill) : '';
    return `https://wa.me/${digits}${text}`;
  }
  if (story.cta_kind === 'tel') {
    return 'tel:' + value.replace(/[^0-9+]/g, '');
  }
  if (story.cta_kind === 'link') {
    return /^https?:\/\//i.test(value) ? value : ('https://' + value);
  }
  return null;
}

/** Parse a stored path fragment `stories/YYYY/MM/id.json` into
 *  { year, month, id } for URL building. Falls back to now-based
 *  path when a story was created client-side and hasn't landed
 *  server-side yet (defensive — the composer always saves before
 *  showing archive controls). */
export function storyPathParts(story) {
  if (!story) return null;
  const created = story.created_at ? new Date(story.created_at) : new Date();
  return {
    year: String(created.getUTCFullYear()),
    month: String(created.getUTCMonth() + 1).padStart(2, '0'),
    id: String(story.id || ''),
  };
}

/** Resize a browser-picked File to a canvas-encoded JPEG (or WebP)
 *  data URL. Used by the composer to keep POST bodies under the
 *  server-side 1.5 MB cap regardless of what the moderator uploaded.
 *
 *  Returns `{ full, thumb }` — the full-frame image (max 1080x1920,
 *  Instagram-story ratio) and the ring thumbnail (max 96x160).
 *  Both are JPEG at quality 0.85 which cuts a typical 2 MB poster
 *  down to ~150-300 KB while staying visually sharp on retina. */
export async function resizeStoryImage(file) {
  if (!(file instanceof Blob)) throw new Error('file must be a Blob');
  const bmp = await loadBitmap(file);
  const full = drawScaled(bmp, 1080, 1920, 0.85);
  const thumb = drawScaled(bmp, 96, 160, 0.8);
  bmp.close && bmp.close();
  return { full, thumb };
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch (_e) { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function drawScaled(bmp, maxW, maxH, quality) {
  const iw = bmp.width || bmp.naturalWidth || maxW;
  const ih = bmp.height || bmp.naturalHeight || maxH;
  const ratio = Math.min(maxW / iw, maxH / ih, 1);
  const w = Math.max(1, Math.round(iw * ratio));
  const h = Math.max(1, Math.round(ih * ratio));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}
