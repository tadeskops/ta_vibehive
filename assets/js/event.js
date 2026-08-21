// ta_vibehive · Event config validator + Alpine component (G1-01)
//
// This module is shipped to the browser (no node: APIs).
// - `validateEventConfig(raw)` is a pure function suitable for node --test.
// - `formatINR` + `formatDate` are DOM-safe (text only, no HTML).
// - `eventPage()` is the Alpine component that fetches + renders the event.
//
// Trust model: config file is served from same origin under a strict CSP
// (no fetch to other origins). Config is treated as untrusted input and every
// field is type-checked. Rendering uses Alpine `x-text` only — never `x-html`.

const REQUIRED_KEYS = ['id', 'title', 'purpose', 'goal_inr', 'cluster', 'dates', 'tiers_inr'];

export function validateEventConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('event: config must be an object');
  }
  for (const k of REQUIRED_KEYS) {
    if (!(k in raw)) throw new Error(`event: missing required key '${k}'`);
  }
  if (typeof raw.id !== 'string' || !/^[a-z0-9-]{3,40}$/.test(raw.id)) {
    throw new Error('event: id must be lowercase-kebab, 3-40 chars');
  }
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0 || raw.title.length > 120) {
    throw new Error('event: title must be non-empty string ≤ 120 chars');
  }
  if (typeof raw.purpose !== 'string' || raw.purpose.length > 400) {
    throw new Error('event: purpose must be string ≤ 400 chars');
  }
  if (typeof raw.goal_inr !== 'number' || !Number.isFinite(raw.goal_inr) || raw.goal_inr <= 0 || raw.goal_inr > 100_000_000) {
    throw new Error('event: goal_inr must be positive number ≤ 10 crore');
  }
  if (typeof raw.cluster !== 'string' || !/^[A-D]$/.test(raw.cluster)) {
    throw new Error('event: cluster must be one of A/B/C/D');
  }
  if (!raw.dates || typeof raw.dates !== 'object' ||
      typeof raw.dates.start !== 'string' || typeof raw.dates.end !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(raw.dates.start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(raw.dates.end)) {
    throw new Error('event: dates.start / dates.end must be YYYY-MM-DD');
  }
  if (new Date(raw.dates.start) > new Date(raw.dates.end)) {
    throw new Error('event: dates.start must be ≤ dates.end');
  }
  if (!Array.isArray(raw.tiers_inr) || raw.tiers_inr.length < 1 || raw.tiers_inr.length > 6) {
    throw new Error('event: tiers_inr must be array of 1-6 amounts');
  }
  for (const t of raw.tiers_inr) {
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 1_000_000) {
      throw new Error('event: each tier must be integer between 1 and 10 lakh');
    }
  }
  return raw;
}

// Rupee formatter with ₹ prefix and Indian digit grouping (e.g. 2,50,000).
export function formatINR(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const s = Math.round(n).toString();
  // Indian grouping: last 3 digits, then groups of 2.
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const withCommas = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return '₹' + withCommas;
}

// Human date: "14 Sept 2026". No time.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
export function formatDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (m < 1 || m > 12) return '';
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Cluster → CSS tint token. Kept as a data map, applied via a class name (never
// as inline style — inline style would violate CSP).
const CLUSTER_CLASS = { A: 'is-terra', B: 'is-sage', C: 'is-gold', D: 'is-ink' };
export function clusterClass(cluster) {
  return CLUSTER_CLASS[cluster] || 'is-terra';
}

// Alpine component (browser only).
export function eventPage(configUrl) {
  return {
    loading: true,
    error: '',
    event: null,
    async init() {
      try {
        const res = await fetch(configUrl, { credentials: 'omit', cache: 'no-store' });
        if (!res.ok) throw new Error(`event: config HTTP ${res.status}`);
        const raw = await res.json();
        this.event = validateEventConfig(raw);
        this.loading = false;
      } catch (e) {
        this.error = e && e.message ? e.message : String(e);
        this.loading = false;
      }
    },
    get inr()          { return formatINR(this.event ? this.event.goal_inr : 0); },
    get startDate()    { return this.event ? formatDate(this.event.dates.start) : ''; },
    get endDate()      { return this.event ? formatDate(this.event.dates.end)   : ''; },
    get clusterCls()   { return this.event ? clusterClass(this.event.cluster)   : ''; },
    tierLabel(t)       { return formatINR(t); },
  };
}

// Wire component into Alpine when this module is imported by app.js.
if (typeof window !== 'undefined' && typeof window.__tvhRegisterEvent === 'undefined') {
  window.__tvhRegisterEvent = (Alpine, configUrl) => {
    Alpine.data('eventPage', () => eventPage(configUrl));
  };
}
