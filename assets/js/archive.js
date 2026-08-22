/* archive.js — push queued receipt archive entries to the private records
 * repo as ONE commit via the GitHub Trees + Commits REST API.
 *
 * Design goals (versatile writer):
 *   - One atomic commit per push (N files).
 *   - Handles transient failures with jittered exponential backoff:
 *       429 / secondary rate limit, 5xx, and network errors.
 *   - Auto-bootstraps empty repos with a first README commit so the
 *     archive can begin on a freshly created target.
 *   - Falls back to the repo's real default branch when the configured
 *     branch does not exist (404 on ref).
 *   - Retries "not a fast forward" (422) races by rebuilding the
 *     commit on top of a freshly fetched head sha.
 *   - Converts each terminal GitHub error into a friendly, actionable
 *     message (`GhError.friendly`) so the caller can toast something
 *     the operator can act on.
 *
 * PAT scope: a fine-grained PAT with `Contents: Read+Write` on the
 * target private repo only. NEVER a classic PAT. The PAT lives in
 * browser localStorage under the society overrides area — the browser
 * is the ONLY place it appears; nothing is proxied through a server.
 */
'use strict';

const API = 'https://api.github.com';
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 4000;

class GhError extends Error {
  constructor(status, url, body) {
    const raw = typeof body === 'string' ? body.slice(0, 200) : (body && body.message) || 'unknown';
    super(`GitHub ${status} on ${url}: ${raw}`);
    this.status = status;
    this.body = body;
    this.url = url;
    this.friendly = friendlyMessageFor(status, body, url);
  }
}

async function gh(token, method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
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
  } catch (netErr) {
    const err = new GhError(0, path, netErr && netErr.message ? netErr.message : 'network error');
    err.transient = true;
    throw err;
  }
  if (!res.ok) {
    let payload;
    try { payload = await res.json(); } catch { payload = await res.text().catch(() => ''); }
    const err = new GhError(res.status, path, payload);
    err.transient = isTransientStatus(res.status, payload, res.headers);
    throw err;
  }
  return res.json();
}

/** Push N archive entries as ONE commit. Returns { commitSha, treeSha, url }.
 *  On terminal failure throws GhError (with `.friendly` set for UI toasts).
 *  On transient failure retries with jittered exponential backoff. */
export async function pushBatch({ owner, repo, branch, token, entries, message }) {
  if (!owner || !repo || !branch || !token) throw new Error('archive.pushBatch: missing owner/repo/branch/token');
  if (!Array.isArray(entries) || !entries.length) throw new Error('archive.pushBatch: no entries');

  const enc = safeRepoPath;
  let currentBranch = String(branch || 'main').trim() || 'main';
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      /* 1 · head ref (with empty-repo bootstrap + default-branch fallback) */
      let ref;
      try {
        ref = await gh(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}/git/ref/heads/${enc(currentBranch)}`);
      } catch (err) {
        if (err && err.status === 409 && isEmptyRepoError(err)) {
          await bootstrapEmptyRepo(token, owner, repo, currentBranch);
          ref = await gh(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}/git/ref/heads/${enc(currentBranch)}`);
        } else if (err && err.status === 404) {
          /* Configured branch doesn't exist — fall back to the repo's
           * real default branch (handles master, trunk, etc.). */
          const fallback = await defaultBranchOf(token, owner, repo);
          if (fallback && fallback !== currentBranch) {
            currentBranch = fallback;
            ref = await gh(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}/git/ref/heads/${enc(currentBranch)}`);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
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

      /* 6 · move ref (fast-forward). If someone advanced main during
       * this attempt, we get a 422 which triggers a retry with a
       * fresh head sha on the outer loop. */
      await gh(token, 'PATCH', `/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${enc(currentBranch)}`, {
        sha: commit.sha,
        force: false,
      });

      return {
        commitSha: commit.sha,
        treeSha: tree.sha,
        url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
        fileCount: blobs.length,
        branch: currentBranch,
      };
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < MAX_ATTEMPTS - 1;
      const nonFastForward = err && err.status === 422 && isNonFastForwardError(err);
      const transient = err && err.transient === true;
      if (canRetry && (nonFastForward || transient)) {
        await sleepBackoff(attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('archive: pushBatch exhausted retries');
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

/** Detect GitHub's "Git Repository is empty." 409 payload. */
function isEmptyRepoError(err) {
  const msg = errBodyMessage(err);
  return /repository is empty/i.test(msg);
}

/** Detect GitHub's "Update is not a fast forward" 422 payload. */
function isNonFastForwardError(err) {
  const msg = errBodyMessage(err);
  return /not a fast forward/i.test(msg);
}

/** Detect GitHub's secondary rate limit / abuse detection payload. */
function isSecondaryRateLimit(payload) {
  const msg = payload && (payload.message || payload) ? String(payload.message || payload) : '';
  return /secondary rate limit|abuse detection/i.test(msg);
}

function errBodyMessage(err) {
  if (!err) return '';
  const body = err.body;
  return typeof body === 'string'
    ? body
    : (body && body.message) ? String(body.message) : '';
}

function isTransientStatus(status, payload, headers) {
  if (status === 0) return true;                      // network
  if (status >= 500 && status <= 599) return true;    // server error
  if (status === 429) return true;                    // rate limit
  if (status === 403 && isSecondaryRateLimit(payload)) return true;
  /* Optional: honour retry-after when GitHub asks us to wait. */
  if (headers && (headers.get('retry-after') || headers.get('Retry-After'))) return true;
  return false;
}

async function sleepBackoff(attempt) {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * base * 0.4);
  await new Promise(r => setTimeout(r, base + jitter));
}

/** Look up the repo's real default branch. Used to fall back when the
 *  configured branch does not exist (returns 404 on ref lookup). */
async function defaultBranchOf(token, owner, repo) {
  const enc = safeRepoPath;
  try {
    const info = await gh(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}`);
    return String(info && info.default_branch || '').trim() || null;
  } catch (_e) {
    return null;
  }
}

/** Create an initial README.md via the Contents API. This succeeds on
 *  an empty repo, sets the default branch to `branch`, and gives us a
 *  head sha to build subsequent commits on. */
async function bootstrapEmptyRepo(token, owner, repo, branch) {
  const enc = safeRepoPath;
  const path = 'README.md';
  const content = toBase64Utf8(
    `# ${owner}/${repo}\n\nInitialised automatically by VibeHive archive writer.\n`
  );
  await gh(token, 'PUT', `/repos/${enc(owner)}/${enc(repo)}/contents/${path}`, {
    message: 'chore: initialise archive repository',
    content,
    branch,
  });
}

/** Translate a GitHub REST failure into a short, actionable message
 *  the UI can toast. */
function friendlyMessageFor(status, body, url) {
  const msg = typeof body === 'string' ? body : (body && body.message) || '';
  if (status === 0) {
    return `Could not reach GitHub (${msg || 'network error'}). Check connectivity and CSP.`;
  }
  if (status === 401) {
    return 'Archive PAT was rejected by GitHub (Bad credentials). Generate a fresh fine-grained PAT and paste it in Settings.';
  }
  if (status === 403) {
    if (/rate limit/i.test(msg)) return 'GitHub rate limit hit. Wait a minute and try again.';
    if (/resource not accessible/i.test(msg)) return 'Archive PAT is missing "Contents: Read and write" permission on the target repo.';
    return 'GitHub blocked the request (403). Check PAT scopes and org access rules.';
  }
  if (status === 404) {
    if (/git\/ref\/heads/i.test(url)) return 'Configured archive branch does not exist. The writer will fall back to the repo default branch — save again to retry.';
    return 'Archive repository not found. Verify owner/repo and that the PAT has access to it.';
  }
  if (status === 409 && /repository is empty/i.test(msg)) {
    return 'Archive repository is empty. The writer bootstrapped it with README.md — save again to complete the first archive commit.';
  }
  if (status === 422 && /not a fast forward/i.test(msg)) {
    return 'Archive branch advanced during push. Save again — the writer will rebase and retry.';
  }
  if (status === 422) {
    return `GitHub rejected the archive update: ${msg || 'validation failed'}.`;
  }
  if (status >= 500 && status <= 599) {
    return `GitHub server error (${status}). Try again shortly.`;
  }
  return `Archive push failed: GitHub ${status}${msg ? ` — ${msg}` : ''}.`;
}
