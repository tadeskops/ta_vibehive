/* API client — the ONLY way the frontend talks to server-side data.
 *
 * Data source of truth: the private archive repo (via the Worker at
 * `TVH_WORKER_URL`). No business data lives in browser localStorage
 * anymore — only the Google JWT (for auth) and unsaved form drafts.
 *
 * On any signed-in request we attach the Google ID token as a Bearer
 * header; the Worker verifies it via jose and resolves role.
 *
 * All responses use the shared envelope: { ok: true, data: T } or
 * { ok: false, error: { message } }. This client unwraps `data` on
 * success and throws an ApiError on failure so callers can `await`
 * without checking `ok`.
 */
'use strict';

/* Configured at app bootstrap. See index.html for the actual value. */
const DEFAULT_WORKER = 'https://tvh-worker.tadeskops.workers.dev';
function baseUrl() {
  const configured = typeof window !== 'undefined' && window.TVH_WORKER_URL;
  return String(configured || DEFAULT_WORKER).replace(/\/+$/, '');
}

/** Read the current Google ID token from the persisted GIS session. */
function currentToken() {
  if (typeof window === 'undefined' || !window.Auth || typeof window.Auth.token !== 'function') return null;
  try { return window.Auth.token() || null; } catch (_e) { return null; }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function ensureFreshToken() {
  if (typeof window === 'undefined' || !window.Auth) return null;
  const token = currentToken();
  if (token) return token;
  /* Google Identity Services usually silently refreshes the ID token
   * on `signIn()` if the user already granted consent to this origin.
   * Only when consent was never given (or was revoked) will a UI
   * prompt appear. */
  try {
    if (typeof window.Auth.signIn === 'function') {
      await window.Auth.signIn({ silent: true }).catch(() => window.Auth.signIn());
    }
  } catch (_e) { /* re-sign-in cancelled — caller sees 401 */ }
  return currentToken();
}

async function request(method, path, body) {
  const doFetch = async (token) => {
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(baseUrl() + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit',
      mode: 'cors',
    });
  };

  let token = currentToken();
  let res = await doFetch(token);
  if (res.status === 401) {
    /* Either no token in memory, or we sent a stale one Google
     * already invalidated. Trigger a silent GIS re-auth, then retry
     * once. We always retry — even when a token was already present
     * — because an expired JWT looks identical to no token from the
     * Worker's perspective. */
    const fresh = await ensureFreshToken();
    if (fresh && fresh !== token) {
      token = fresh;
      res = await doFetch(token);
    }
  }

  let payload = null;
  try { payload = await res.json(); } catch (_e) { /* empty body */ }
  if (!res.ok || !payload || payload.ok !== true) {
    const msg = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${res.status}`;
    /* Rewrite the classic 401 message so operators see a next step
     * ("sign in again") instead of a bare "sign in required" toast on
     * flows where the user thinks they are already signed in. */
    if (res.status === 401) {
      throw new ApiError(401, 'Your session expired. Please sign in again and retry.');
    }
    throw new ApiError(res.status, msg);
  }
  return payload.data;
}

/* ---------- Auth / identity ---------- */

/** Returns { email, name, role } for the current signed-in user, or
 *  null when anonymous. Never throws on 401 — that just means the
 *  visitor is anonymous. */
export async function whoami() {
  try {
    return await request('GET', '/whoami');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/* ---------- Settings ---------- */

/** Society-overrides document + current file sha (for optimistic lock). */
export async function readSettings() {
  return request('GET', '/settings');
}

/** Save the overrides doc. Pass `expectedSha` (from a prior read) to
 *  detect concurrent writes from another admin. */
export async function writeSettings(overrides, expectedSha) {
  return request('PUT', '/settings', { overrides, ...(expectedSha ? { expectedSha } : {}) });
}

/* ---------- Events ---------- */

/** List all events visible to the caller. Anonymous callers get only
 *  published + closed; committee+ get everything. */
export async function listEvents() {
  const data = await request('GET', '/events');
  return (data && data.events) || [];
}

/** Single event by slug. */
export async function readEvent(slug) {
  return request('GET', '/events/' + encodeURIComponent(slug));
}

/** Create / update an event. `event` must include `id`, `title`,
 *  `status`. Server stamps `updated_at`/`updated_by`. Pass
 *  `expectedSha` to guard against concurrent writers. */
export async function writeEvent(slug, event, expectedSha) {
  return request('PUT', '/events/' + encodeURIComponent(slug), { event, ...(expectedSha ? { expectedSha } : {}) });
}

/* ---------- Contributions ---------- */

/** List contributions visible to the caller. Optionally filter by event slug. */
export async function listContributions(eventFilter) {
  const qs = eventFilter ? '?event=' + encodeURIComponent(eventFilter) : '';
  const data = await request('GET', '/contributions' + qs);
  return (data && data.contributions) || [];
}

/** Submit a new contribution. Server stamps `id`, `created_at`,
 *  `created_by`, and `status='pending'`. Returned contribution has
 *  `_path` set so a later verify call knows the archive location. */
export async function createContribution(contribution) {
  const data = await request('POST', '/contributions', { contribution });
  if (data && data.contribution && data.path && !data.contribution._path) {
    data.contribution._path = data.path;
  }
  return data;
}

/** Verify a pending contribution. Committee+. `contribPath` is the
 *  storage path returned by `createContribution` (e.g. `contributions/
 *  2026/08/c-xxx.json`) — the year/month/id are parsed from it. */
export async function verifyContribution(contribPath) {
  const m = String(contribPath || '').match(/contributions\/(\d{4})\/(\d{2})\/([^/]+)\.json$/);
  if (!m) throw new ApiError(400, 'Invalid contribution path');
  const [, year, month, id] = m;
  return request('POST', `/contributions/${year}/${month}/${encodeURIComponent(id)}/verify`);
}

/* ---------- Expenses ---------- */

/** List expenses visible to the caller. Optionally filter by event id. */
export async function listExpenses(eventFilter) {
  const qs = eventFilter ? '?event=' + encodeURIComponent(eventFilter) : '';
  const data = await request('GET', '/expenses' + qs);
  return (data && data.expenses) || [];
}

/** Submit an expense. Server stamps `id`, `created_at`, `created_by`.
 *  Committee+ may pass `status:'verified'` to record an already-paid
 *  expense; residents are silently forced to pending. */
export async function createExpense(expense) {
  const data = await request('POST', '/expenses', { expense });
  if (data && data.expense && data.path && !data.expense._path) {
    data.expense._path = data.path;
  }
  return data;
}

/** Verify a pending expense. Committee+. `expensePath` is the storage
 *  path returned by `createExpense` (e.g. `expenses/2026/08/exp-xxx.json`). */
export async function verifyExpenseRemote(expensePath, comment) {
  const m = String(expensePath || '').match(/expenses\/(\d{4})\/(\d{2})\/([^/]+)\.json$/);
  if (!m) throw new ApiError(400, 'Invalid expense path');
  const [, year, month, id] = m;
  return request('POST', `/expenses/${year}/${month}/${encodeURIComponent(id)}/verify`, comment ? { comment } : {});
}

/** Update an existing expense (committee+). Patch payload is merged
 *  on the server; server-controlled fields (id, status, created_by,
 *  verified_*) are preserved. */
export async function updateExpense(expensePath, patch) {
  const m = String(expensePath || '').match(/expenses\/(\d{4})\/(\d{2})\/([^/]+)\.json$/);
  if (!m) throw new ApiError(400, 'Invalid expense path');
  const [, year, month, id] = m;
  return request('PUT', `/expenses/${year}/${month}/${encodeURIComponent(id)}`, { expense: patch });
}

/** Delete an expense (committee+). Idempotent — a missing file is
 *  treated as already-deleted. */
export async function deleteExpenseRemote(expensePath) {
  const m = String(expensePath || '').match(/expenses\/(\d{4})\/(\d{2})\/([^/]+)\.json$/);
  if (!m) throw new ApiError(400, 'Invalid expense path');
  const [, year, month, id] = m;
  return request('DELETE', `/expenses/${year}/${month}/${encodeURIComponent(id)}`);
}

/** Void a pending or verified contribution (committee+). Status
 *  becomes `void`; the record is preserved for audit. */
export async function voidContributionRemote(contribPath, reason) {
  const m = String(contribPath || '').match(/contributions\/(\d{4})\/(\d{2})\/([^/]+)\.json$/);
  if (!m) throw new ApiError(400, 'Invalid contribution path');
  const [, year, month, id] = m;
  return request('POST', `/contributions/${year}/${month}/${encodeURIComponent(id)}/void`, reason ? { reason } : {});
}

/** Edit an existing contribution (admin / secretary / mgmt).
 *  Patch payload is merged on the server; server-controlled fields
 *  such as id, status, created_at, verified_at and receipt_id are
 *  preserved. */
export async function updateContribution(contribPath, patch) {
  const m = String(contribPath || '').match(/contributions\/(\d{4})\/(\d{2})\/([^/]+)\.json$/);
  if (!m) throw new ApiError(400, 'Invalid contribution path');
  const [, year, month, id] = m;
  return request('PUT', `/contributions/${year}/${month}/${encodeURIComponent(id)}`, { contribution: patch });
}

/** Delete an event (admin only). Contributions and expenses are left
 *  in place; only `event.json` is removed. Idempotent. */
export async function deleteEventRemote(slug) {
  return request('DELETE', '/events/' + encodeURIComponent(slug));
}

/* ---------- Metrics ---------- */

/** Read the site-wide visit counter (`{ total, today }`). Anonymous
 *  callers are allowed — used by the footer visit-count chip. */
export async function readVisitCount() {
  return request('GET', '/metrics/visit');
}

/** Increment the visit counter (once per browser per UTC day —
 *  callers are expected to dedup client-side). */
export async function bumpVisitCount() {
  return request('POST', '/metrics/visit');
}

/* ---------- Stories ---------- */

/** List active, non-expired dashboard stories (thumbnails only). */
export async function listStories() {
  const data = await request('GET', '/stories');
  return (data && data.stories) || [];
}

/** Fetch a single story's full record (heavy `image_data_url` included). */
export async function readStory(year, month, id) {
  const data = await request('GET', `/stories/${year}/${month}/${encodeURIComponent(id)}`);
  return (data && data.story) || null;
}

/** Create a story. Committee+. */
export async function createStory(story) {
  const data = await request('POST', '/stories', { story });
  return data && data.story;
}

/** Archive a story (soft delete — status='archived'). Committee+. */
export async function archiveStoryRemote(year, month, id) {
  return request('POST', `/stories/${year}/${month}/${encodeURIComponent(id)}/archive`);
}

/** Hard-delete a story (mgmt+). */
export async function deleteStoryRemote(year, month, id) {
  return request('DELETE', `/stories/${year}/${month}/${encodeURIComponent(id)}`);
}
