/* Runtime archive writer.
 *
 * Purpose:
 *  - Keep the existing outbox queue contract.
 *  - Attempt immediate push of queued entries to the configured private
 *    archive repo (`receipts.archive_repo`) using GitHub Trees+Commits API.
 *  - If push fails, leave data in outbox for retry (no data loss).
 */
'use strict';

import { state, getSociety } from './store.js';
import { pushBatch } from './archive.js';

/** Sanitize an overrides object for archival — strips secrets that
 *  must never leave the browser. Central so every push flow uses the
 *  same policy. */
export function sanitizeForArchive(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone.receipts && typeof clone.receipts === 'object') {
    delete clone.receipts.archive_pat;
  }
  return clone;
}

function mergeDeep(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = mergeDeep(target[k] && typeof target[k] === 'object' ? { ...target[k] } : {}, v);
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
}

/** Fetch a JSON file from the configured archive repo. Returns null
 *  when the file does not exist or archive is not reachable. Used to
 *  merge remote state with the current local overrides before we
 *  push, so a fresh browser never overwrites the shared source of
 *  truth in the archive repo. */
export async function fetchRemoteJson(path) {
  const soc = await getSociety().catch(() => null);
  if (!isArchiveEnabled(soc)) return null;
  const repoRefs = archiveRepoCandidates(soc);
  const token = archiveToken(soc);
  const branch = archiveBranch(soc);
  if (!repoRefs.length || !token) return null;
  for (const repoRef of repoRefs) {
    try {
      const url = `https://api.github.com/repos/${repoRef.owner}/${repoRef.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        credentials: 'omit',
      });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      const payload = await res.json();
      const content = payload && payload.content ? String(payload.content).replace(/\n/g, '') : '';
      if (!content) return null;
      const decoded = atob(content);
      const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
      const text = new TextDecoder('utf-8').decode(bytes);
      try { return JSON.parse(text); } catch (_e) { return null; }
    } catch (_e) { /* try next repo */ }
  }
  return null;
}

/** Merge the local overrides on top of the remote copy so a partial
 *  local state never wipes shared config. Returns the merged object
 *  ready to be sanitized + pushed. */
export async function mergeOverridesWithRemote(localOverrides, remotePath = 'settings/society-overrides.json') {
  const remote = await fetchRemoteJson(remotePath).catch(() => null);
  const localClone = localOverrides && typeof localOverrides === 'object'
    ? JSON.parse(JSON.stringify(localOverrides))
    : {};
  if (!remote || typeof remote !== 'object') return localClone;
  return mergeDeep(JSON.parse(JSON.stringify(remote)), localClone);
}

function parseRepo(s) {
  const m = String(s || '').trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function archiveRepoCandidates(soc) {
  const over = state.societyOverrides() || {};
  const fromOver = [
    over && over.receipts && over.receipts.archive_repo,
    over && over.receipts && over.receipts.archive_repo_fallback,
  ];
  const fromBase = [
    soc && soc.receipts && soc.receipts.archive_repo,
    soc && soc.receipts && soc.receipts.archive_repo_fallback,
  ];
  const seen = new Set();
  const out = [];
  for (const raw of fromOver.concat(fromBase)) {
    const ref = parseRepo(raw);
    if (!ref) continue;
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function isArchiveEnabled(soc) {
  return !!(soc && soc.receipts && soc.receipts.archive && soc.receipts.archive.enabled);
}

function archiveToken(soc) {
  /* Secrets bucket first — the PAT lives in `tvh:v1:secrets` and is
   * NEVER pushed to any repo. Legacy overrides.receipts.archive_pat
   * is auto-migrated the first time `state.archivePat()` is called
   * (see store.js). */
  const fromSecrets = state.archivePat();
  if (fromSecrets) return fromSecrets;
  const over = state.societyOverrides() || {};
  const overTok = over && over.receipts && over.receipts.archive_pat;
  const baseTok = soc && soc.receipts && soc.receipts.archive_pat;
  return String(overTok || baseTok || '').trim();
}

function archiveBranch(soc) {
  const b = soc && soc.receipts && soc.receipts.archive_branch;
  return String(b || 'main').trim() || 'main';
}

function markArchivedByEntries(entries) {
  if (!entries || !entries.length) return;
  const list = state.contribs();
  let changed = false;
  for (const e of entries) {
    if (!e || !e.receiptId) continue;
    const rec = list.find(c => c && c.receipt && c.receipt.id === e.receiptId);
    if (rec && rec.receipt && !rec.receipt.archived) {
      rec.receipt.archived = true;
      changed = true;
    }
  }
  if (changed) state.saveContribs(list);
}

function requeue(entries) {
  for (const e of entries || []) state.enqueueArchive(e);
}

export async function flushArchiveQueueNow(opts = {}) {
  const queued = state.outbox();
  if (!queued.length) return { ok: true, empty: true, count: 0 };

  const soc = await getSociety().catch(() => null);
  if (!isArchiveEnabled(soc)) {
    return { ok: false, reason: 'archive_disabled', count: queued.length };
  }

  const repoRefs = archiveRepoCandidates(soc);
  const token = archiveToken(soc);
  const branch = archiveBranch(soc);
  if (!repoRefs.length || !token) {
    return { ok: false, reason: 'archive_not_configured', count: queued.length };
  }

  const drained = state.drainOutbox();
  if (!drained.length) return { ok: true, empty: true, count: 0 };

  let lastErr = null;
  for (const repoRef of repoRefs) {
    try {
      const summary = await pushBatch({
        owner: repoRef.owner,
        repo: repoRef.repo,
        branch,
        token,
        entries: drained,
        message: opts.message || `tvh archive: ${drained.length} entr${drained.length === 1 ? 'y' : 'ies'}`,
      });
      markArchivedByEntries(drained);
      state.audit({
        actor: opts.actor || null,
        action: 'archive.push.ok',
        detail: `${drained.length} entries · ${repoRef.owner}/${repoRef.repo} · ${summary.commitSha || ''}`.trim(),
      });
      return {
        ok: true,
        count: drained.length,
        commitSha: summary.commitSha,
        url: summary.url,
        fileCount: summary.fileCount,
        targetRepo: `${repoRef.owner}/${repoRef.repo}`,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  requeue(drained);
  state.audit({
    actor: opts.actor || null,
    action: 'archive.push.fail',
    detail: (lastErr && lastErr.message) ? lastErr.message.slice(0, 220) : 'unknown error',
  });
  const friendly = lastErr && lastErr.friendly ? lastErr.friendly : null;
  return {
    ok: false,
    reason: 'push_failed',
    error: lastErr,
    friendly,
    count: drained.length,
    triedRepos: repoRefs.map(r => `${r.owner}/${r.repo}`),
  };
}

export async function queueAndMaybePushArchive(entry, opts = {}) {
  state.enqueueArchive(entry);
  if (opts.immediate === false) {
    return { ok: true, queued: true, immediateTried: false };
  }
  const out = await flushArchiveQueueNow({
    actor: opts.actor || null,
    message: opts.message || 'tvh archive: immediate push',
  });
  return { ...out, queued: true, immediateTried: true };
}
