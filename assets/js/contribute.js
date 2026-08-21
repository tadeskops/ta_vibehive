// ta_vibehive · Contribute logic (G1-02)
//
// Pure amount validator + draft persistence + Alpine component.
// No server calls yet — draft is stored in localStorage and read again by
// G1-03 (UPI/UTR capture). Every submission is rate-limited via G0-04's
// `checkRate` and every write is size-bounded.

import { checkRate } from './ratelimit.js';
import { getIdentity, setIdentity } from './identity.js';

// Amount policy (Ganpati 2026):
export const CONTRIB_MIN_INR = 101;
export const CONTRIB_MAX_INR = 500000;    // ₹5 lakh individual cap
export const CONTRIB_RATE_MAX_PER_HR = 6; // bucket per event

export function validateAmount(raw, opts = {}) {
  const min = typeof opts.min === 'number' ? opts.min : CONTRIB_MIN_INR;
  const max = typeof opts.max === 'number' ? opts.max : CONTRIB_MAX_INR;
  // Reject falsy, non-number-shaped input
  if (raw === '' || raw === null || raw === undefined) {
    throw new Error('contribute: amount required');
  }
  // Accept string form of an integer only. No whitespace, no decimals,
  // no sign, no separators — Rupees are whole and the UI uses type=number.
  const s = String(raw);
  if (!/^\d{1,7}$/.test(s)) {
    throw new Error('contribute: amount must be a whole rupee integer');
  }
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error('contribute: amount must be a whole rupee integer');
  }
  if (n < min) throw new Error(`contribute: minimum is ₹${min}`);
  if (n > max) throw new Error(`contribute: maximum is ₹${max}`);
  return n;
}

// Draft schema kept small and typed so localStorage tampering can't smuggle
// unexpected shapes into later slices.
const DRAFT_KEY = 'tvh.contrib.draft';

export function saveDraft(store, draft) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return false;
  const safe = {
    eventId:   String(draft.eventId || ''),
    amountInr: Number(draft.amountInr) || 0,
    anonymous: !!draft.anonymous,
    ts:        Date.now(),
  };
  try {
    s.setItem(DRAFT_KEY, JSON.stringify(safe));
    return true;
  } catch { return false; }
}

export function readDraft(store) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return null;
  try {
    const raw = s.getItem(DRAFT_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    if (typeof j.eventId !== 'string' || typeof j.amountInr !== 'number' ||
        typeof j.anonymous !== 'boolean' || typeof j.ts !== 'number') return null;
    return j;
  } catch { return null; }
}

export function clearDraft(store) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return;
  try { s.removeItem(DRAFT_KEY); } catch { /* no-op */ }
}

// Alpine component. Uses event config to seed tier choices.
export function contributePage(configUrl, eventId) {
  return {
    loading: true,
    error: '',
    tiers: [],
    selectedTier: null,       // number or 'custom'
    customAmount: '',
    anonymous: false,
    name: '',
    flat: '',
    submitting: false,
    submitError: '',
    submitted: false,
    async init() {
      try {
        const res = await fetch(configUrl, { credentials: 'omit', cache: 'no-store' });
        if (!res.ok) throw new Error('event: config HTTP ' + res.status);
        const cfg = await res.json();
        if (!Array.isArray(cfg.tiers_inr)) throw new Error('event: tiers missing');
        this.tiers = cfg.tiers_inr;
        // Seed identity from G0-04 store if present.
        const id = getIdentity();
        if (id) {
          this.name = id.name || '';
          this.flat = id.flat || '';
          this.anonymous = !!id.anonymous;
        }
        // Seed draft if present (survives reload).
        const d = readDraft();
        if (d && d.eventId === eventId) {
          if (this.tiers.includes(d.amountInr)) this.selectedTier = d.amountInr;
          else { this.selectedTier = 'custom'; this.customAmount = String(d.amountInr); }
          this.anonymous = d.anonymous;
        }
        this.loading = false;
      } catch (e) {
        this.error = e && e.message ? e.message : String(e);
        this.loading = false;
      }
    },
    get effectiveAmount() {
      if (this.selectedTier === 'custom') {
        const n = Number(this.customAmount);
        return Number.isInteger(n) ? n : 0;
      }
      return Number(this.selectedTier) || 0;
    },
    pickTier(t) { this.selectedTier = t; if (t !== 'custom') this.customAmount = ''; },
    submit() {
      this.submitError = '';
      try {
        // 1. Validate identity fields (unless anonymous elects to skip name).
        //    Anonymous still needs a flat so the committee can attribute internally.
        const nameOk = this.anonymous || (this.name && this.name.trim().length > 0);
        if (!nameOk) throw new Error('contribute: name required (or tick anonymous)');
        setIdentity({ name: this.anonymous ? '' : this.name, flat: this.flat, anonymous: this.anonymous });
        // 2. Validate amount.
        const amt = validateAmount(
          this.selectedTier === 'custom' ? this.customAmount : this.selectedTier
        );
        // 3. Rate-limit per event.
        const rl = checkRate('contribute-' + eventId, CONTRIB_RATE_MAX_PER_HR);
        if (!rl.ok) throw new Error('contribute: rate limit — retry in ' + Math.ceil(rl.resetInSec / 60) + ' min');
        // 4. Persist draft.
        saveDraft(null, { eventId, amountInr: amt, anonymous: this.anonymous });
        this.submitted = true;
        // 5. Navigate to pay screen (G1-03). Falls back to relative path.
        setTimeout(() => { window.location.assign('./pay/'); }, 400);
      } catch (e) {
        this.submitError = e && e.message ? e.message : String(e);
      }
    },
  };
}
