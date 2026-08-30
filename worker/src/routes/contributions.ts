import type { Ctx } from '../lib/ctx.ts';
import { ok, err } from '../lib/envelope.ts';
import { readJson, writeJson, writeBinary, readBinaryBase64, listDir } from '../github/client.ts';
import { atLeast } from '../auth/roles.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Contribution storage layout in the archive repo:
 *   contributions/{YYYY}/{MM}/{contribId}.json
 *
 * Each file is a self-contained record:
 *   { id, event, amount, contributor: {name,email,flat,mobile},
 *     method, ref, status, remarks, created_at, created_by,
 *     verified_at?, verified_by?, receipt_id? }
 *
 * Anyone signed in can create (self or on-behalf). Committee+ can
 * verify. Committee+ can list all; residents can list their own only.
 */

interface Contribution extends Record<string, unknown> {
  id: string;
  event: string;
  amount: number;
  status: 'pending' | 'verified' | 'void';
  contributor_email?: string;
  created_at?: string;
  created_by?: string;
  verified_at?: string;
  verified_by?: string;
  receipt_id?: string;
}

function pathFor(id: string, created?: string): string {
  const d = created ? new Date(created) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const safe = String(id || '').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 60);
  return `contributions/${y}/${m}/${safe}.json`;
}

function newId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(36))
    .join('');
  return `c-${Date.now().toString(36)}-${rand}`;
}

/** Slugify an event id or flat number to a safe path segment. */
function safeSegment(v: unknown): string {
  return String(v || '').trim().replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown';
}

/** Map a data-URL MIME type to a file extension. Falls back to `bin`. */
function extForMime(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  if (m === 'application/pdf') return 'pdf';
  return 'bin';
}

/** Reverse of `extForMime` — used to reconstruct the data-URL mime
 *  type when serving an archived proof binary back to the client. */
function mimeForExt(ext: string): string {
  const e = String(ext || '').toLowerCase();
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  if (e === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * Persist the raw payment-proof binary at
 *   contributions/{YYYY}/{event}/{flat}/{contribId}.{ext}
 * so the record repo carries the transaction receipt separately from
 * the JSON envelope. Returns the archive path on success, or null
 * when the record has no proof / event / flat to hang it under.
 * Failures are swallowed — the JSON write is the source of truth
 * and a missing binary parallel-write must never break the API call.
 */
async function archiveProofBinary(ctx: Ctx, record: Contribution): Promise<string | null> {
  const dataUrl = String((record as Record<string, unknown>)['proof_data_url'] || '');
  const flat = String((record as Record<string, unknown>)['flat'] || '');
  const event = String(record.event || '');
  if (!dataUrl || !flat || !event) return null;
  const m = dataUrl.match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const b64 = m[2] || '';
  if (!b64) return null;
  const created = String(record.created_at || new Date().toISOString());
  const year = new Date(created).getUTCFullYear();
  const ext = extForMime(mime);
  const path = `contributions/${year}/${safeSegment(event)}/${safeSegment(flat)}/${safeSegment(record.id)}.${ext}`;
  const message = `contribution: archive proof for ${record.id} (${event}/${flat}) by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    await writeBinary(ctx.env, path, b64, message);
    return path;
  } catch (_e) {
    return null;
  }
}

/**
 * POST /contributions
 * Body: { contribution: Partial<Contribution> }
 * Any signed-in user (or anonymous when publicly configured — not
 * enabled by default). Server stamps id, created_at, created_by,
 * status='pending'.
 *
 * Dedup: rejects a second submission that matches an existing non-void
 * record on any of these fingerprints —
 *  (event, ref)  when ref looks like a real UPI/bank reference   ALWAYS
 *  (event, ref)  when ref is a generic/placeholder value          same-person, within 5m
 *  (event, flat|email, same-person, within 5m)   fast-tap / forgot-proof re-submit
 * "Same person" = same contributor id, or same normalised
 * contributor_email / contributor_mobile / contributor_name. Without
 * this guard, two distinct flatmates (or an on-behalf submission for
 * a different resident in the same flat) get wrongly collapsed into
 * a single "duplicate".
 * A "real" ref needs >=6 chars AND at least one digit — genuine UPI
 * refs (12 digits) and NEFT UTRs (alphanumeric) both satisfy this.
 * Short/non-numeric values like "UTR", "NA", "test" are common user
 * typos/placeholders and are NOT globally unique, so they only count
 * as a duplicate when the same person repeats them (same bug class
 * as the flat/email false positives above — two different residents
 * both literally typing "UTR" must not collide).
 */
const DEDUP_WINDOW_MS = 5 * 60_000;
function normDigits(v: unknown): string { return String(v || '').replace(/\D+/g, ''); }
function normText(v: unknown): string { return String(v || '').trim().toLowerCase(); }
function looksLikeRealRef(v: string): boolean { return v.length >= 6 && /\d/.test(v); }
async function findDuplicate(
  env: Ctx['env'],
  draft: Partial<Contribution> & Record<string, unknown>,
): Promise<Contribution | null> {
  const eventId = String(draft.event || '');
  if (!eventId) return null;
  const ref = normText(draft['ref']);
  const refIsReal = looksLikeRealRef(ref);
  const email = normText(draft['contributor_email']);
  const mobile = normDigits(draft['contributor_mobile']);
  const name = normText(draft['contributor_name']);
  const contributor = normText(draft['contributor']);
  const flat = normText(draft['flat']);
  const nowT = Date.now();
  const all = await loadAllContributions(env);
  for (const c of all) {
    if (c.event !== eventId) continue;
    if (c.status === 'void') continue;
    const cRef = normText((c as Record<string, unknown>)['ref']);
    if (ref && cRef && ref === cRef && refIsReal) return c;
    const createdT = Date.parse(String(c.created_at || '')) || 0;
    if (!createdT || nowT - createdT > DEDUP_WINDOW_MS) continue;
    const cEmail = normText(c.contributor_email);
    const cMobile = normDigits((c as Record<string, unknown>)['contributor_mobile']);
    const cName = normText((c as Record<string, unknown>)['contributor_name']);
    const cContributor = normText((c as Record<string, unknown>)['contributor']);
    const cFlat = normText((c as Record<string, unknown>)['flat']);
    const samePerson = (
      (contributor && cContributor && contributor === cContributor) ||
      (email && cEmail && email === cEmail) ||
      (mobile && cMobile && mobile === cMobile) ||
      (name && cName && name === cName)
    );
    if (!samePerson) continue;
    if (ref && cRef && ref === cRef) return c;
    if (email && cEmail && email === cEmail) return c;
    if (flat && cFlat && flat === cFlat) return c;
  }
  return null;
}

export async function createContribution(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  let body: { contribution?: Partial<Contribution> };
  try { body = await ctx.req.json(); } catch (_e) { return err(ctx.env, ctx.req, 'Invalid JSON body', 400); }
  const draft = body.contribution;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return err(ctx.env, ctx.req, '`contribution` must be an object', 400);
  }
  if (!draft.event || typeof draft.event !== 'string') return err(ctx.env, ctx.req, 'event is required', 400);
  if (typeof draft.amount !== 'number' || !(draft.amount > 0)) return err(ctx.env, ctx.req, 'amount must be positive', 400);
  const dup = await findDuplicate(ctx.env, draft);
  if (dup) {
    return err(
      ctx.env,
      ctx.req,
      'This contribution is already recorded.',
      409,
      {
        code: 'DUPLICATE_CONTRIBUTION',
        contribution: {
          id: dup.id,
          event: dup.event,
          contributor_name: dup['contributor_name'] || '',
          amount: dup.amount,
          status: dup.status,
          created_at: dup.created_at || null,
          receipt_id: dup.receipt_id || null,
        },
      },
    );
  }
  const nowIso = new Date().toISOString();
  const stamped: Contribution = {
    ...(draft as Contribution),
    id: newId(),
    status: 'pending',
    created_at: nowIso,
    created_by: ctx.identity?.email ?? 'unknown',
  };
  const path = pathFor(stamped.id, nowIso);
  const message = `contribution: submitted by ${ctx.identity?.email ?? 'unknown'} for ${stamped.event}`;
  try {
    const archivePath = await archiveProofBinary(ctx, stamped);
    if (archivePath) (stamped as Record<string, unknown>)['proof_archive_path'] = archivePath;
    /* Persist the lean record only. The proof binary already lives at
     * proof_archive_path — storing the same ~100-700KB base64 blob
     * again inline here would force every dedup/list scan to decode
     * + JSON.parse it on every request, which is what caused the
     * CF-1102 CPU-limit outages under festival-week traffic. The
     * caller's own immediate response still carries `stamped` (with
     * the blob) so their screen shows the image right away. */
    const toStore: Contribution = { ...stamped };
    if (archivePath) delete (toStore as Record<string, unknown>)['proof_data_url'];
    const result = await writeJson(ctx.env, path, toStore, message);
    invalidateContribCache();
    return ok(ctx.env, ctx.req, { contribution: stamped, path, sha: result.sha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * GET /contributions/:year/:month/:id/proof
 * Returns the payment-proof image/PDF as a data URL, read from the
 * dedicated binary path (proof_archive_path) rather than the JSON
 * record — bulk list/dedup reads never have to decode it this way.
 * Visibility matches the record itself: committee+ always; a
 * resident only for their own contribution.
 */
export async function getContributionProof(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `contributions/${year}/${month}/${id}.json`;
  const doc = await readJson<Contribution>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Contribution not found', 404);
  const callerEmail = String(ctx.identity?.email || '').toLowerCase();
  const isMine = String(doc.data.contributor_email || doc.data.created_by || '').toLowerCase() === callerEmail;
  if (!atLeast(ctx.role, 'committee') && !isMine) return err(ctx.env, ctx.req, 'Not visible with your role', 403);
  /* Legacy records written before this fix still carry the blob
   * inline — serve it straight from the JSON rather than 404ing. */
  const inline = String((doc.data as Record<string, unknown>)['proof_data_url'] || '');
  if (inline) return ok(ctx.env, ctx.req, { proof_data_url: inline });
  const archivePath = String((doc.data as Record<string, unknown>)['proof_archive_path'] || '');
  if (!archivePath) return err(ctx.env, ctx.req, 'No proof attached', 404);
  const bin = await readBinaryBase64(ctx.env, archivePath);
  if (!bin) return err(ctx.env, ctx.req, 'Proof file not found', 404);
  const ext = archivePath.split('.').pop() || '';
  return ok(ctx.env, ctx.req, { proof_data_url: `data:${mimeForExt(ext)};base64,${bin.base64}` });
}

/**
 * POST /contributions/:year/:month/:id/verify
 * Committee+ only. Body: {}. Server marks status='verified', stamps
 * verified_at/verified_by. Optionally mints a deterministic receipt id.
 */
export async function verifyContribution(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  /* Anonymous callers get a 401 so the frontend's silent-refresh
   * retry can attempt to recover the session. Genuine role
   * mismatches still fall through to 403. */
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `contributions/${year}/${month}/${id}.json`;
  const doc = await readJson<Contribution>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Contribution not found', 404);
  if (doc.data.status === 'verified') return ok(ctx.env, ctx.req, { contribution: doc.data, sha: doc.sha, already: true });
  const verifiedAt = new Date().toISOString();
  const receiptId = mintReceiptId(doc.data, verifiedAt);
  const updated: Contribution = {
    ...doc.data,
    status: 'verified',
    verified_at: verifiedAt,
    verified_by: ctx.identity?.email ?? 'unknown',
    receipt_id: receiptId,
  };
  const message = `contribution: verified ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, updated, message, doc.sha);
    invalidateContribCache();
    return ok(ctx.env, ctx.req, { contribution: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * PUT /contributions/:year/:month/:id
 * Committee+ only (mgmt / secretary / admin in practice; frontend
 * gates via the `contributions.edit` permission). Body:
 * { contribution: Partial<Contribution> }. Merges over the stored
 * record, preserving server-controlled fields such as id, status,
 * created_at, verified_at and receipt_id so a caller cannot forge
 * attribution.
 */
export async function putContribution(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `contributions/${year}/${month}/${id}.json`;
  const doc = await readJson<Contribution>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Contribution not found', 404);
  let body: { contribution?: Partial<Contribution> };
  try { body = await ctx.req.json(); } catch (_e) { return err(ctx.env, ctx.req, 'Invalid JSON body', 400); }
  const patch = body.contribution;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return err(ctx.env, ctx.req, '`contribution` must be an object', 400);
  }
  const nowIso = new Date().toISOString();
  const updated: Contribution = {
    ...doc.data,
    ...patch,
    id: doc.data.id,
    event: doc.data.event,
    status: doc.data.status,
    created_at: doc.data.created_at,
    created_by: doc.data.created_by,
    verified_at: doc.data.verified_at,
    verified_by: doc.data.verified_by,
    receipt_id: doc.data.receipt_id,
    updated_at: nowIso,
    updated_by: ctx.identity?.email ?? 'unknown',
  } as Contribution;
  const message = `contribution: updated ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const patchHasProof = typeof (patch as Record<string, unknown>)['proof_data_url'] === 'string'
      && String((patch as Record<string, unknown>)['proof_data_url'] || '').length > 0;
    let archivePath = '';
    if (patchHasProof) {
      archivePath = await archiveProofBinary(ctx, updated) || '';
      if (archivePath) (updated as Record<string, unknown>)['proof_archive_path'] = archivePath;
    }
    /* Same lean-storage rule as create: don't persist the inline blob
     * once it's archived separately (see comment in createContribution). */
    const toStore: Contribution = { ...updated };
    if (archivePath) delete (toStore as Record<string, unknown>)['proof_data_url'];
    const result = await writeJson(ctx.env, path, toStore, message, doc.sha);
    invalidateContribCache();
    return ok(ctx.env, ctx.req, { contribution: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * POST /contributions/:year/:month/:id/void
 * Committee+ only. Body: { reason?: string }. Marks status='void'
 * without deleting the file, preserving the audit trail.
 */
export async function voidContribution(ctx: Ctx, params: Record<string, string>): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  if (!atLeast(ctx.role, 'committee')) return err(ctx.env, ctx.req, 'Committee or above required', 403);
  const year = params['year'];
  const month = params['month'];
  const id = params['id'];
  if (!year || !month || !id) return err(ctx.env, ctx.req, 'year, month and id are required', 400);
  const path = `contributions/${year}/${month}/${id}.json`;
  const doc = await readJson<Contribution>(ctx.env, path);
  if (!doc) return err(ctx.env, ctx.req, 'Contribution not found', 404);
  if (doc.data.status === 'void') return ok(ctx.env, ctx.req, { contribution: doc.data, sha: doc.sha, already: true });
  let reason: string | undefined;
  try {
    const body = await ctx.req.json() as { reason?: string };
    if (body && typeof body.reason === 'string') reason = body.reason.trim() || undefined;
  } catch (_e) { /* no body is fine */ }
  const nowIso = new Date().toISOString();
  const updated: Contribution = {
    ...doc.data,
    status: 'void',
    void_at: nowIso,
    void_by: ctx.identity?.email ?? 'unknown',
    void_reason: reason,
  };
  const message = `contribution: voided ${id} by ${ctx.identity?.email ?? 'unknown'}`;
  try {
    const result = await writeJson(ctx.env, path, updated, message, doc.sha);
    invalidateContribCache();
    return ok(ctx.env, ctx.req, { contribution: updated, sha: result.sha, commitSha: result.commitSha });
  } catch (e) {
    if (e instanceof HttpError) return err(ctx.env, ctx.req, e.message, e.status);
    throw e;
  }
}

/**
 * GET /contributions?event=<slug>
 * Committee+ sees full data for every contribution. Residents see
 * their OWN records in full and every OTHER record with sensitive
 * fields (email, ref, remarks, receipt id) stripped so a resident
 * cannot fingerprint or replay another resident's payment.
 *
 * Names, flats and amounts stay on the wire so the frontend can render
 * a community feed and compute totals; hiding a specific field from
 * the visual list is a UI concern handled per-view in home.js.
 *
 * Anonymous callers get 401.
 */
function stripPrivateFields(c: Contribution): Contribution {
  const out: Contribution = {
    id: c.id,
    event: c.event,
    amount: c.amount,
    status: c.status,
    created_at: c.created_at,
    verified_at: c.verified_at,
  };
  const src = c as Record<string, unknown>;
  if (typeof src['contributor_name'] === 'string') out['contributor_name'] = src['contributor_name'];
  if (typeof src['flat'] === 'string') out['flat'] = src['flat'];
  if (typeof src['method'] === 'string') out['method'] = src['method'];
  if (typeof src['anonymous'] === 'boolean') out['anonymous'] = src['anonymous'];
  return out;
}

/**
 * Sequential read of all contributions in the current window.
 * Kept intentionally simple — this is the exact shape `listExpenses`
 * has always used successfully. No isolate cache, no fan-out, no
 * retry/union-fallback logic layered on top: those were added to
 * patch symptoms of an intermittent bug that the sequential pattern
 * doesn't have in the first place. Any performance concern re-opens
 * only once we have real cold-start latency evidence — until then,
 * "simple + always correct" beats "fast + sometimes drops records".
 */
const LIST_MONTHS = 3;

async function loadAllContributions(env: Ctx['env']): Promise<Contribution[]> {
  const now = new Date();
  const out: Contribution[] = [];
  for (let i = 0; i < LIST_MONTHS; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    let entries;
    try { entries = await listDir(env, `contributions/${y}/${m}`); }
    catch (_e) { continue; }
    for (const e of entries) {
      if (e.type !== 'file' || !e.name.endsWith('.json')) continue;
      try {
        const doc = await readJson<Contribution>(env, e.path);
        if (doc && doc.data) out.push(doc.data);
      } catch (_e) { /* one bad file must not tank the whole list */ }
    }
  }
  return out;
}

/** Cache invalidation is now a no-op — kept as a call site so future
 *  write handlers don't need to change shape if we reintroduce a
 *  cache later with real benchmark data behind it. */
function invalidateContribCache(): void { /* intentionally empty */ }

export async function listContributions(ctx: Ctx): Promise<Response> {
  if (ctx.role === 'anonymous') return err(ctx.env, ctx.req, 'Sign in required', 401);
  const eventFilter = ctx.url.searchParams.get('event') || '';
  const callerEmail = String(ctx.identity?.email || '').toLowerCase();
  const canSeeAll = atLeast(ctx.role, 'committee');
  const all = await loadAllContributions(ctx.env);
  const out: Contribution[] = [];
  for (const c of all) {
    if (eventFilter && c.event !== eventFilter) continue;
    if (canSeeAll) { out.push(c); continue; }
    const mine = String(c.contributor_email || c.created_by || '').toLowerCase() === callerEmail;
    out.push(mine ? c : stripPrivateFields(c));
  }
  return ok(ctx.env, ctx.req, { contributions: out });
}

/**
 * Deterministic receipt id derived from event type + verification timestamp.
 * Format: <EVENT_TYPE>-<YYYYMMDD>-<HHMM>. Matches the frontend policy
 * so verified contributions can be referenced consistently on either
 * side of the wire.
 */
function mintReceiptId(c: Contribution, verifiedAt: string): string {
  const t = new Date(verifiedAt);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  const type = String(c['cluster'] || c['template'] || c['event'] || 'EVENT')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return `${type}-${y}${m}${d}-${hh}${mm}`;
}
