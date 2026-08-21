/* Archive path template resolver — mirrors ta-society-helpdesk
 * lib/receipt-archive.ts so both projects share the same mental model:
 * one template string with braced placeholders, resolved deterministically,
 * yields a repo-safe file path.
 *
 * Supported placeholders:
 *   {eventCode}         FEST | SOC | SPRT | DON | EMER | INFR   (upper)
 *   {eventCodeLower}    fest | soc | sprt | ...                 (lower)
 *   {eventId}           evt-…
 *   {receiptId}         TA-FEST-2026-08-22-134502-0001-A1B2C3D4
 *   {id}                same as {receiptId} (tsh compatibility)
 *   {contribId}         ctr-…
 *   {year}              2026
 *   {month}             08
 *   {day}               22
 *   {yearMonth}         2026-08
 *   {date}              2026-08-22
 *   {flat}              A-101   (path-safe, upper; falls back to "unknown")
 *   {contributor}       ramesh@… → ramesh_at_    (safe, lower)
 *   {amount}            5000
 *   {period}            monthly | quarterly | yearly    (rollup only)
 *   {periodKey}         2026-08 | 2026-Q3 | 2026        (rollup only)
 */
'use strict';

const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;

/** Resolve `{name}` tokens against the vars map. Missing keys become empty. */
export function renderPathTemplate(tpl, vars) {
  return String(tpl || '').replace(PLACEHOLDER_RE, (_full, k) => vars[k] != null ? String(vars[k]) : '');
}

/** Normalise arbitrary text for use inside a repo file path: keep letters,
 *  digits, dash; collapse whitespace/slashes to dash; strip everything else;
 *  fall back to 'unknown' on empty. */
export function sanitizeForPath(raw, fallback = 'unknown') {
  const s = String(raw || '').trim();
  if (!s) return fallback;
  const cleaned = s
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^A-Za-z0-9_\-.]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/** Compute the placeholder map for a (contribution, event) pair. */
export function archiveVars(contribution, event) {
  const receiptId = contribution.receipt && contribution.receipt.id || '';
  const iso = (contribution.receipt && contribution.receipt.issued_at) || contribution.verified_at || new Date().toISOString();
  const d = new Date(iso);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const code = ((event && event.template) || 'gen').slice(0, 4).toUpperCase();
  return {
    eventCode: code,
    eventCodeLower: code.toLowerCase(),
    eventId: (event && event.id) || '',
    receiptId,
    id: receiptId,
    contribId: contribution.id || '',
    year: y,
    month: m,
    day,
    yearMonth: `${y}-${m}`,
    date: `${y}-${m}-${day}`,
    flat: sanitizeForPath(contribution.flat, 'unknown').toUpperCase(),
    contributor: sanitizeForPath((contribution.contributor || '').replace(/@/g, '_at_'), 'anon').toLowerCase(),
    amount: String(contribution.amount || 0),
  };
}

/** Resolve the archive path for a single receipt, guarding against traversal. */
export function archivePathFor(contribution, event, archiveCfg) {
  const tpl = (archiveCfg && archiveCfg.perReceiptPath) || DEFAULT_ARCHIVE.perReceiptPath;
  const vars = archiveVars(contribution, event);
  const out = renderPathTemplate(tpl, vars);
  return out.replace(/^\/+/, '').replace(/\.\.+/g, '.');
}

/** Compute the rollup key for a given date + period. */
export function rollupKeyFor(iso, period) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (period === 'yearly')    return String(y);
  if (period === 'quarterly') return `${y}-Q${Math.ceil(m / 3)}`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export const DEFAULT_ARCHIVE = Object.freeze({
  enabled: true,
  perReceiptPath: '{eventCodeLower}/{yearMonth}/{flat}_{receiptId}.json',
  rollup: Object.freeze({
    enabled: true,
    period: 'monthly',
    path: '{eventCodeLower}/bckp/{period}/{periodKey}.json',
  }),
});
