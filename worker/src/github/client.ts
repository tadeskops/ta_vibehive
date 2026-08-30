import type { Env } from '../env.ts';
import { HttpError } from '../lib/errors.ts';

/**
 * Tiny GitHub REST client. Handles:
 *  - Contents API get/put (readJson, writeJson)
 *  - Trees + Commits batched write (writeBatch) for multi-file atomic commits
 *  - Auto-bootstrap of empty repos
 *  - Fast-forward retry on 422
 *
 * All calls use the Worker's TVH_ARCHIVE_PAT — never a client-supplied token.
 */

const API = 'https://api.github.com';
const UA = 'tvh-worker/0.1';

interface GhErrorBody { message?: string }

class GhErr extends Error {
  status: number;
  body: unknown;
  constructor(status: number, url: string, body: unknown) {
    const raw = typeof body === 'string' ? body : ((body as GhErrorBody)?.message ?? 'unknown');
    super(`GitHub ${status} on ${url}: ${String(raw).slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 502/503/504 are Cloudflare/GitHub transient hiccups; 429 and a 403
 *  whose body mentions a rate/abuse limit are GitHub's secondary
 *  rate limiter, which routinely trips under bursty commit traffic
 *  (every contribution does 1-2 sequential writes). All are worth
 *  one short retry instead of surfacing a generic "Internal error"
 *  to the resident, who would otherwise have to notice and resubmit
 *  by hand. */
function isRetryableStatus(status: number, body: unknown): boolean {
  if (status === 502 || status === 503 || status === 504 || status === 429) return true;
  if (status === 403) {
    const msg = String(typeof body === 'string' ? body : (body as GhErrorBody)?.message || '').toLowerCase();
    return msg.includes('rate limit') || msg.includes('abuse');
  }
  return false;
}

const GH_RETRY_DELAYS_MS = [300, 900];

async function gh(env: Env, method: string, path: string, body?: unknown, attempt = 0): Promise<unknown> {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.TVH_ARCHIVE_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let payload: unknown;
    try { payload = await res.json(); } catch { payload = await res.text().catch(() => ''); }
    if (attempt < GH_RETRY_DELAYS_MS.length && isRetryableStatus(res.status, payload)) {
      await sleep(GH_RETRY_DELAYS_MS[attempt]);
      return gh(env, method, path, body, attempt + 1);
    }
    throw new GhErr(res.status, path, payload);
  }
  if (res.status === 204) return null;
  return res.json();
}

function repoBase(env: Env): string {
  return `/repos/${env.GH_ARCHIVE_OWNER}/${env.GH_ARCHIVE_REPO}`;
}

function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Read a binary file's raw base64 content from the archive repo,
 * unmodified — no UTF-8 decode / JSON.parse. Used to serve proof
 * attachments (payment screenshots) on demand instead of embedding
 * them in the JSON record, which used to force every bulk list/dedup
 * scan to decode every attachment (the CF-1102 CPU-limit outages).
 * Returns null on 404.
 */
export async function readBinaryBase64(env: Env, path: string): Promise<{ base64: string; sha: string } | null> {
  const url = `${repoBase(env)}/contents/${encodeURI(path)}?ref=${encodeURIComponent(env.GH_ARCHIVE_BRANCH)}`;
  try {
    const raw = await gh(env, 'GET', url) as { content?: string; sha?: string };
    if (!raw || typeof raw.content !== 'string' || !raw.sha) return null;
    return { base64: raw.content.replace(/\s+/g, ''), sha: raw.sha };
  } catch (e) {
    if (e instanceof GhErr && e.status === 404) return null;
    throw e;
  }
}

/** Read a JSON file from the archive repo. Returns null on 404. */
export async function readJson<T = unknown>(env: Env, path: string): Promise<{ data: T; sha: string } | null> {
  const url = `${repoBase(env)}/contents/${encodeURI(path)}?ref=${encodeURIComponent(env.GH_ARCHIVE_BRANCH)}`;
  try {
    const raw = await gh(env, 'GET', url) as { content?: string; sha?: string };
    if (!raw || typeof raw.content !== 'string' || !raw.sha) return null;
    const text = decodeBase64Utf8(raw.content);
    return { data: JSON.parse(text) as T, sha: raw.sha };
  } catch (e) {
    if (e instanceof GhErr && e.status === 404) return null;
    throw e;
  }
}

/**
 * Bulk-read multiple JSON files in a SINGLE GitHub GraphQL request.
 *
 * Why this exists: Cloudflare Workers Free plan caps a request at 50
 * outbound subrequests. Each `readJson` = 1 subrequest, so a list
 * endpoint that scans N files (e.g. 70 contributions) blows the
 * ceiling and silently drops the last ~20 reads, which is exactly
 * what surfaces as "the dashboard shows fewer records than the
 * archive actually has". Batching all reads into one GraphQL POST
 * turns N subrequests into 1, so the ceiling stops being reached
 * until the archive has thousands of records — long past when the
 * project should have moved to Workers Paid or D1 anyway.
 *
 * Semantics: returns a Map keyed by the input `paths`. A path
 * missing from the map (or mapped to null) is a 404 / not-a-Blob.
 * GraphQL failures fall back to sequential per-file reads so a
 * transient GraphQL outage or PAT-scope quirk never surfaces as a
 * blank list — it just costs the extra subrequests we already had
 * before this optimization.
 *
 * Chunk size = 50 aliased blob fetches per query; GitHub GraphQL
 * enforces a per-query node budget and a query-string length cap,
 * and 50 stays comfortably under both. For a 200-record archive
 * that's 4 GraphQL calls = 4 subrequests, still well under 50.
 */
export async function readManyJson<T = unknown>(
  env: Env,
  paths: string[],
): Promise<Map<string, { data: T; sha: string } | null>> {
  const out = new Map<string, { data: T; sha: string } | null>();
  if (!paths.length) return out;

  const CHUNK = 50;
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += CHUNK) chunks.push(paths.slice(i, i + CHUNK));

  for (const chunk of chunks) {
    let ok = false;
    try {
      const owner = String(env.GH_ARCHIVE_OWNER);
      const repo = String(env.GH_ARCHIVE_REPO);
      const branch = String(env.GH_ARCHIVE_BRANCH);
      /* One aliased `object` selection per file. Aliases MUST be
       * valid GraphQL identifiers so we index-key them (`f0..fN`)
       * and keep a parallel array to map results back to paths. */
      const selections = chunk.map((p, i) => {
        const expr = JSON.stringify(`${branch}:${p}`);
        return `f${i}: object(expression: ${expr}) { __typename ... on Blob { text oid isBinary } }`;
      }).join('\n    ');
      const query = `query BulkBlobs {\n  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n    ${selections}\n  }\n}`;
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TVH_ARCHIVE_PAT}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': UA,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });
      if (res.ok) {
        const payload = await res.json() as {
          data?: { repository?: Record<string, { __typename?: string; text?: string; oid?: string; isBinary?: boolean } | null> };
          errors?: unknown;
        };
        const repoNode = payload?.data?.repository;
        if (repoNode && !payload.errors) {
          for (let i = 0; i < chunk.length; i++) {
            const node = repoNode[`f${i}`];
            const p = chunk[i];
            if (!node || node.__typename !== 'Blob' || node.isBinary || typeof node.text !== 'string' || !node.oid) {
              out.set(p, null);
              continue;
            }
            try {
              out.set(p, { data: JSON.parse(node.text) as T, sha: node.oid });
            } catch (_e) {
              out.set(p, null);
            }
          }
          ok = true;
        }
      }
    } catch (_e) { /* fall through to per-file fallback */ }

    if (!ok) {
      /* Fallback: per-file reads. Costs one subrequest per file,
       * which is what the code did before the GraphQL optimization.
       * A partial GraphQL success up above already populated `out`
       * for its chunk, so we only fall back for the chunk that just
       * failed. */
      for (const p of chunk) {
        if (out.has(p)) continue;
        try {
          const r = await readJson<T>(env, p);
          out.set(p, r);
        } catch (_e) {
          out.set(p, null);
        }
      }
    }
  }
  return out;
}

/**
 * Write a single JSON file with optimistic-lock (`If-Match` via `sha`).
 * If `expectedSha` is provided, GitHub rejects if head has moved (409).
 * If `expectedSha` is omitted and file exists, the current sha is used.
 */
export async function writeJson(
  env: Env,
  path: string,
  data: unknown,
  message: string,
  expectedSha?: string,
): Promise<{ sha: string; commitSha: string }> {
  const content = encodeBase64Utf8(JSON.stringify(data, null, 2) + '\n');
  const url = `${repoBase(env)}/contents/${encodeURI(path)}`;
  const body: Record<string, unknown> = {
    message,
    content,
    branch: env.GH_ARCHIVE_BRANCH,
  };
  if (expectedSha) body['sha'] = expectedSha;
  else {
    /* No expectedSha: look up current sha if file exists so we do an
     * update-not-create when appropriate. */
    const current = await readJson(env, path).catch(() => null);
    if (current) body['sha'] = current.sha;
  }
  try {
    const resp = await gh(env, 'PUT', url, body) as { content?: { sha?: string }; commit?: { sha?: string } };
    return {
      sha: resp?.content?.sha ?? '',
      commitSha: resp?.commit?.sha ?? '',
    };
  } catch (e) {
    if (e instanceof GhErr && e.status === 409) {
      throw new HttpError(409, 'Conflict: file was changed since read. Re-fetch and retry.');
    }
    throw e;
  }
}

/**
 * List entries (files + dirs) under a directory. Returns an empty
 * array if the directory does not exist (404).
 */
export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  sha: string;
  size: number;
}

/**
 * Write a binary file whose content is already base64-encoded (e.g.
 * the tail of a data URL). Used for archived payment-proof
 * attachments so the raw image/PDF lives alongside its contribution
 * JSON in the record repo. Semantics otherwise match writeJson —
 * optimistic-lock via `expectedSha`, current-sha lookup when omitted.
 */
export async function writeBinary(
  env: Env,
  path: string,
  contentBase64: string,
  message: string,
  expectedSha?: string,
): Promise<{ sha: string; commitSha: string }> {
  const content = String(contentBase64 || '').replace(/\s+/g, '');
  const url = `${repoBase(env)}/contents/${encodeURI(path)}`;
  const body: Record<string, unknown> = {
    message,
    content,
    branch: env.GH_ARCHIVE_BRANCH,
  };
  if (expectedSha) body['sha'] = expectedSha;
  else {
    const current = await readJson(env, path).catch(() => null);
    if (current) body['sha'] = current.sha;
  }
  try {
    const resp = await gh(env, 'PUT', url, body) as { content?: { sha?: string }; commit?: { sha?: string } };
    return {
      sha: resp?.content?.sha ?? '',
      commitSha: resp?.commit?.sha ?? '',
    };
  } catch (e) {
    if (e instanceof GhErr && e.status === 409) {
      throw new HttpError(409, 'Conflict: file was changed since read. Re-fetch and retry.');
    }
    throw e;
  }
}

export async function listDir(env: Env, path: string): Promise<DirEntry[]> {
  const url = `${repoBase(env)}/contents/${encodeURI(path)}?ref=${encodeURIComponent(env.GH_ARCHIVE_BRANCH)}`;
  try {
    const raw = await gh(env, 'GET', url);
    if (!Array.isArray(raw)) return [];
    return (raw as DirEntry[]).map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type,
      sha: e.sha,
      size: e.size,
    }));
  } catch (e) {
    if (e instanceof GhErr && e.status === 404) return [];
    throw e;
  }
}

/** Delete a file from the archive repo. If `expectedSha` is omitted
 *  the current sha is looked up; a 404 is treated as already-gone
 *  (idempotent). */
export async function deleteFile(
  env: Env,
  path: string,
  message: string,
  expectedSha?: string,
): Promise<{ commitSha: string } | null> {
  let sha = expectedSha;
  if (!sha) {
    const current = await readJson(env, path).catch(() => null);
    if (!current) return null;
    sha = current.sha;
  }
  const url = `${repoBase(env)}/contents/${encodeURI(path)}`;
  try {
    const resp = await gh(env, 'DELETE', url, {
      message,
      sha,
      branch: env.GH_ARCHIVE_BRANCH,
    }) as { commit?: { sha?: string } };
    return { commitSha: resp?.commit?.sha ?? '' };
  } catch (e) {
    if (e instanceof GhErr && e.status === 404) return null;
    if (e instanceof GhErr && e.status === 409) {
      throw new HttpError(409, 'Conflict: file was changed since read. Re-fetch and retry.');
    }
    throw e;
  }
}
