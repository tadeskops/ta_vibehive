/* Field validators shared across contribute + profile flows.
 *
 * Kept isolated so tests / node --check can parse it without
 * pulling the whole SPA. Every export is a pure function — no DOM,
 * no fetch — so it's cheap to reuse from the events editor if we
 * later want to prefill a "Payer flat" quick-select.
 *
 * Society-specific rules (The Address · Baner):
 *   - Towers A, B, C.
 *   - 13 floors per tower.
 *   - Slots per floor: A = 4, B = 6, C = 4.
 *   - Slot numbers are ALWAYS 2-digit zero-padded (01..06) so parsing
 *     is unambiguous for lower floors: `A-101` = A / floor 1 / slot 01
 *     and `A-1301` = A / floor 13 / slot 01. Dash is optional.
 *
 * If the society ever adds a Tower D, extend `TOWERS` below (single
 * source of truth) — the whole validator picks it up automatically. */
'use strict';

/** Per-tower maximum slot number (1..N) on any floor. */
export const TOWERS = { A: 4, B: 6, C: 4 };

/** Highest allowed floor across all towers. */
export const MAX_FLOOR = 13;

/** Human-readable rule text for form help / error toasts. */
export function flatRuleText() {
  const parts = Object.entries(TOWERS).map(([t, n]) => `${t}: 01–${String(n).padStart(2, '0')}`);
  return `Towers ${Object.keys(TOWERS).join('/')}. Floors 1–${MAX_FLOOR}. Slots per floor — ${parts.join(', ')}.`;
}

/**
 * Parse a flat number into its parts. Case-insensitive. Dash optional.
 * @param {string} raw
 * @returns {{ valid: boolean, tower?: string, floor?: number, slot?: number, canonical?: string, reason?: string }}
 */
export function parseFlat(raw) {
  if (raw == null) return { valid: false, reason: 'Flat number is required.' };
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return { valid: false, reason: 'Flat number is required.' };
  const towerKeys = Object.keys(TOWERS).join('');
  const re = new RegExp(`^([${towerKeys}])[-]?(\\d{1,2})(\\d{2})$`);
  const m = re.exec(s);
  if (!m) {
    return { valid: false, reason: `Use format Tower-FloorSlot, e.g. A-101 or B-1305. (${flatRuleText()})` };
  }
  const tower = m[1];
  const floor = Number(m[2]);
  const slot  = Number(m[3]);
  const maxSlot = TOWERS[tower];
  if (floor < 1 || floor > MAX_FLOOR) {
    return { valid: false, reason: `Floor must be between 1 and ${MAX_FLOOR}.` };
  }
  if (slot < 1 || slot > maxSlot) {
    return { valid: false, reason: `Tower ${tower} has slots 01–${String(maxSlot).padStart(2, '0')} on each floor.` };
  }
  const canonical = `${tower}-${floor}${String(slot).padStart(2, '0')}`;
  return { valid: true, tower, floor, slot, canonical };
}

/** Strips non-digits, drops a leading `91` (country code) or a leading
 *  `0` if the remaining string is exactly 10 digits — so pasting
 *  "+91 98 1234 5678" or "098 1234 5678" both land on a clean 10. */
export function normalizeMobile(raw) {
  const digitsOnly = String(raw || '').replace(/\D+/g, '');
  return digitsOnly
    .replace(/^91(?=\d{10}$)/, '')
    .replace(/^0(?=\d{10}$)/, '');
}

/**
 * Validate an Indian mobile number.
 * @param {string} raw
 * @returns {{ valid: boolean, digits: string, reason?: string }}
 */
export function validateMobile(raw) {
  const digits = normalizeMobile(raw);
  if (!digits) return { valid: false, digits, reason: 'Mobile number is required.' };
  if (digits.length !== 10) return { valid: false, digits, reason: 'Enter a 10-digit mobile number.' };
  if (!/^[6-9]/.test(digits)) return { valid: false, digits, reason: 'Mobile number must start with 6, 7, 8 or 9.' };
  return { valid: true, digits };
}
