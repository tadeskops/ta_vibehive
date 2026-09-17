/**
 * Typed Worker environment.
 * Secrets are injected via `wrangler secret put <NAME>` in production, or
 * `.dev.vars` file (gitignored) locally. Public config lives in wrangler.toml.
 */
export interface Env {
  /** Fine-grained GitHub PAT scoped to the archive repo (contents R/W). */
  TVH_ARCHIVE_PAT: string;

  /** Archive repo owner / repo / branch. */
  GH_ARCHIVE_OWNER: string;
  GH_ARCHIVE_REPO: string;
  GH_ARCHIVE_BRANCH: string;

  /** Google OAuth 2.0 client ID (used to verify the ID token audience). */
  GOOGLE_OAUTH_CLIENT_ID: string;

  /** Comma-separated origin list for CORS. */
  ALLOWED_ORIGINS: string;

  /** debug | info | warn | error */
  LOG_LEVEL: string;

  /** Short git SHA injected at deploy time (`wrangler deploy --var
   *  WORKER_VERSION:<sha>`). Surfaced on the health/version route so CI
   *  can assert the LIVE worker matches the just-pushed commit — i.e.
   *  the deploy actually replaced the running isolate and isn't stale.
   *  Defaults to "dev" locally / in preview. */
  WORKER_VERSION: string;
}
