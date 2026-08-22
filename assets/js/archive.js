/* archive.js — push queued receipt archive entries to the private records
 * repo as ONE commit via the GitHub Trees + Commits REST API.
 *
 * Flow (one push == one atomic commit for N files):
 *   1. GET  /repos/:owner/:repo/git/ref/heads/:branch     → head sha
 *   2. GET  /repos/:owner/:repo/git/commits/:head         → base tree sha
 *   3. POST /repos/:owner/:repo/git/blobs        (× N)    → blob shas
 *   4. POST /repos/:owner/:repo/git/trees                 → new tree sha (base_tree=base)
 *   5. POST /repos/:owner/:repo/git/commits                → new commit sha
 *   6. PATCH /repos/:owner/:repo/git/refs/heads/:branch    → move ref
 *
 * PAT scope: a fine-grained PAT with `Contents: Read+Write` on the target
 * private repo only. NEVER a classic PAT. The PAT lives in localStorage
 * under the client's societyOverrides area — the browser is the ONLY
 * place it appears; nothing is proxied through a server.
 */
'use strict';

const API = 'https://api.github.com';

class GhError extends Error {
  constructor(status, url, body) {
    super(`GitHub ${status} on ${url}: ${typeof body === 'string' ? body.slice(0, 200) : (body && body.message) || 'unknown'}`);
    this.status = status; this.body = body;
  }
}

async function gh(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    credentials: 'omit',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let payload;
    try { payload = await res.json(); } catch { payload = await res.text().catch(() => ''); }
    throw new GhError(res.status, path, payload);
  }
  return res.json();
}

/** Push N archive entries as ONE commit. Returns { commitSha, treeSha, url }.
 *  Rejects with GhError on any REST failure (caller re-enqueues + retries). */
export async function pushBatch({ owner, repo, branch, token, entries, message }) {
  if (!owner || !repo || !branch || !token) throw new Error('archive.pushBatch: missing owner/repo/branch/token');
  if (!Array.isArray(entries) || !entries.length) throw new Error('archive.pushBatch: no entries');

  const enc = safeRepoPath;

  /* 1 · head ref */
  const ref = await gh(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}/git/ref/heads/${enc(branch)}`);
  const headSha = ref.object && ref.object.sha;
  if (!headSha) throw new Error('archive: head ref has no sha');

  /* 2 · base tree via head commit */
  const headCommit = await gh(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}/git/commits/${enc(headSha)}`);
  const baseTreeSha = headCommit.tree && headCommit.tree.sha;
  if (!baseTreeSha) throw new Error('archive: head commit has no tree sha');

  /* 3 · blobs */
  const blobs = [];
  for (const e of entries) {
    const path = String(e.path || '').replace(/^\/+/, '').replace(/\.\.+/g, '.');
    if (!path) continue;
    const binaryB64 = (e && (e.contentBase64 || e.content_base64)) ? String(e.contentBase64 || e.content_base64) : '';
    const contentB64 = (e && e.encoding === 'base64')
      ? String(binaryB64 || e.content || '').replace(/\s+/g, '')
      : toBase64Utf8(String(e.content || ''));
    const blob = await gh(token, 'POST', `/repos/${enc(owner)}/${enc(repo)}/git/blobs`, {
      content: contentB64,
      encoding: 'base64',
    });
    blobs.push({ path, sha: blob.sha });
  }
  if (!blobs.length) throw new Error('archive: no valid entries after path guard');

  /* 4 · tree (add blob leaves on top of the current head tree) */
  const tree = await gh(token, 'POST', `/repos/${enc(owner)}/${enc(repo)}/git/trees`, {
    base_tree: baseTreeSha,
    tree: blobs.map(b => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
  });

  /* 5 · commit */
  const commit = await gh(token, 'POST', `/repos/${enc(owner)}/${enc(repo)}/git/commits`, {
    message: message || `receipts: batched archive (${blobs.length} entr${blobs.length === 1 ? 'y' : 'ies'})`,
    tree: tree.sha,
    parents: [headSha],
  });

  /* 6 · move ref */
  await gh(token, 'PATCH', `/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${enc(branch)}`, {
    sha: commit.sha,
    force: false,
  });

  return {
    commitSha: commit.sha,
    treeSha: tree.sha,
    url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    fileCount: blobs.length,
  };
}

/** UTF-8 → base64. Safe for arbitrary text (Latin-1 btoa would corrupt). */
function toBase64Utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** encodeURIComponent-style for a single path segment. Owners, repos, and
 *  branches use letters/digits/dash/dot/underscore — safe by default. */
function safeRepoPath(seg) {
  return String(seg || '').replace(/[^A-Za-z0-9_.-\/]/g, '');
}
