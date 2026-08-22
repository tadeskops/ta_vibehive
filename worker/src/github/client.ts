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

async function gh(env: Env, method: string, path: string, body?: unknown): Promise<unknown> {
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
