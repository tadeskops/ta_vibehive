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

function parseRepo(s) {
  const m = String(s || '').trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function isArchiveEnabled(soc) {
  return !!(soc && soc.receipts && soc.receipts.archive && soc.receipts.archive.enabled);
}

function archiveToken(soc) {
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

  const repoRef = parseRepo(soc && soc.receipts && soc.receipts.archive_repo);
  const token = archiveToken(soc);
  const branch = archiveBranch(soc);
  if (!repoRef || !token) {
    return { ok: false, reason: 'archive_not_configured', count: queued.length };
  }

  const drained = state.drainOutbox();
  if (!drained.length) return { ok: true, empty: true, count: 0 };

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
      detail: `${drained.length} entries · ${summary.commitSha || ''}`.trim(),
    });
    return {
      ok: true,
      count: drained.length,
      commitSha: summary.commitSha,
      url: summary.url,
      fileCount: summary.fileCount,
    };
  } catch (err) {
    requeue(drained);
    state.audit({
      actor: opts.actor || null,
      action: 'archive.push.fail',
      detail: (err && err.message) ? err.message.slice(0, 220) : 'unknown error',
    });
    return {
      ok: false,
      reason: 'push_failed',
      error: err,
      count: drained.length,
    };
  }
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
