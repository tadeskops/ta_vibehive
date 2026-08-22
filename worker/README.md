# tvh-worker — Cloudflare Worker backing ta_vibehive

Purpose: make GitHub the source of truth for VibeHive. Browser is a
thin client; every business-data read/write goes through this Worker.
The Worker holds the GitHub PAT so the browser never sees it.

## Why this exists

- `ta_vibehive` is a static site on GitHub Pages
- Previously all data lived in browser `localStorage` → no multi-device,
  no multi-user, no audit trail, and the PAT had to live in browser
- This Worker moves the PAT to the server, mediates every read/write,
  and commits every change as a real git commit in the archive repo

Pattern is a direct port of the TSH worker.

## Data model in the archive repo (`tvh_record`)

```
settings/
  society-overrides.json      # branding, payment UPI, receipt config
config/
  access.json                 # role → email lists (role mapping)
events/
  {slug}/event.json           # one file per event, updated in place
contributions/
  {yyyy}/{mm}/{id}.json       # one file per contribution
receipts/
  {yyyy}/{mm}/{id}.json       # one file per verified receipt
```

## Routes (v0.1)

| Method | Path              | Role required     | Purpose                    |
|--------|-------------------|-------------------|----------------------------|
| GET    | `/healthz`        | anonymous         | health check               |
| GET    | `/whoami`         | any signed-in     | who am I + resolved role   |
| GET    | `/settings`       | any signed-in     | read society overrides     |
| PUT    | `/settings`       | admin             | write society overrides    |
| GET    | `/events`         | any               | list events (filtered)     |
| GET    | `/events/:slug`   | any               | single event               |
| PUT    | `/events/:slug`   | committee+        | create/update event        |

Every mutating route returns the new file `sha`; the client sends that
back as `expectedSha` next time to get optimistic-lock protection.

## Deploy (fully automated — recommended)

Once these three GitHub repository secrets are set, every push to
`worker/**` deploys the Worker to Cloudflare automatically:

1. `CLOUDFLARE_API_TOKEN` — https://dash.cloudflare.com/profile/api-tokens
   - "Create Token" → "Edit Cloudflare Workers" template → save the value
2. `CLOUDFLARE_ACCOUNT_ID` — visible in the right sidebar of any Cloudflare page
3. `TVH_ARCHIVE_PAT` — the fine-grained GitHub PAT with `Contents: Read+Write`
   on the archive repository (`tadeskops/tvh_record`)

Add them at: https://github.com/tadeskops/ta_vibehive/settings/secrets/actions/new

Then run **once** (Actions → "sync-worker-secrets" → Run workflow) to
push `TVH_ARCHIVE_PAT` into the Cloudflare Worker secret store. From
now on:

- Push code to `worker/**` → GitHub Actions runs `deploy-worker.yml`
  → Worker redeploys within ~30 seconds
- Rotate the PAT → update the `TVH_ARCHIVE_PAT` repository secret →
  re-run "sync-worker-secrets"

You never need to run `wrangler` on your laptop again.

## Deploy (manual, only if you can't use GitHub Actions)

Prerequisites
1. Cloudflare account (free tier is fine)
2. `wrangler` CLI: `npm install -g wrangler`
3. `wrangler login`

Install worker deps

```powershell
cd ta_vibehive\worker
npm install
```

Set the Worker secrets (never commit these)

```powershell
# The fine-grained GitHub PAT with Contents R/W on tvh_record
wrangler secret put TVH_ARCHIVE_PAT
# paste the token when prompted
```

Configure `wrangler.toml`

- `GOOGLE_OAUTH_CLIENT_ID` — replace with the same client id used by
  the ta_vibehive frontend (`window.TVH_GOOGLE_CLIENT_ID`)
- `ALLOWED_ORIGINS` — comma-separated list of origins allowed to call
  the Worker (Pages URL + localhost for dev)

Deploy

```powershell
npm run deploy
```

Wrangler prints the URL, e.g. `https://tvh-worker.<subdomain>.workers.dev`.

## Local dev

```powershell
# 1. Create .dev.vars (gitignored) with your PAT for local testing:
#    TVH_ARCHIVE_PAT="github_pat_xxx"
# 2. Run:
npm run dev
```

Worker listens on `http://localhost:8788` (see `wrangler.toml [dev]`).

## Bootstrap access map

Before signed-in users can be recognised as admins, seed the access map:

Create `config/access.json` in the archive repo (once, by hand) with:

```json
{
  "role_emails": {
    "admin": ["your.email@example.com"]
  }
}
```

After the Worker is deployed, any subsequent role changes can be made
via the frontend Settings UI → PUT /settings.

## Testing after deploy

```powershell
# 1. Health check (no auth):
curl https://tvh-worker.<subdomain>.workers.dev/healthz

# 2. Whoami (needs a Google ID token; grab from a signed-in browser):
$T = "eyJhbGciOi..."  # ID token from a signed-in browser DevTools
curl -H "Authorization: Bearer $T" https://tvh-worker.<subdomain>.workers.dev/whoami

# 3. Settings read:
curl -H "Authorization: Bearer $T" https://tvh-worker.<subdomain>.workers.dev/settings
```

Once all three return `{"ok": true, ...}`, the Worker is live and the
frontend retrofit (Slice 2) can begin.
