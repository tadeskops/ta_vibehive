/* ta_vibehive · app.js · Alpine.js entry (G0-02)
 *
 * Only two responsibilities in this slice:
 *   1. Provide the reactive shell store for the home page (language + theme).
 *   2. Register the Alpine components used by index.html.
 *
 * Language toggle is a stub for G0-02: it flips the html[lang] attribute and
 * writes the choice to localStorage. Actual translations arrive post-launch
 * (per tvh_plan.md §1.2 deferred list).
 *
 * Theme picker is a stub too: Community Warmth is the only theme available
 * pre-launch. The picker exists so brand exploration mode can be enabled
 * post-launch without a page rewrite.
 */

const LANGS = ['en', 'mr', 'hi'];
const DEFAULT_LANG = 'en';

function readLang() {
  try {
    const v = localStorage.getItem('tvh.lang');
    return LANGS.includes(v) ? v : DEFAULT_LANG;
  } catch { return DEFAULT_LANG; }
}

function writeLang(lang) {
  try { localStorage.setItem('tvh.lang', lang); } catch { /* no-op */ }
}

function shell() {
  return {
    lang: readLang(),
    themeOpen: false,
    setLang(next) {
      if (!LANGS.includes(next)) return;
      this.lang = next;
      document.documentElement.setAttribute('lang', next);
      writeLang(next);
    },
    init() {
      document.documentElement.setAttribute('lang', this.lang);
    },
  };
}

document.addEventListener('alpine:init', () => {
  // eslint-disable-next-line no-undef
  Alpine.data('shell', shell);
});
