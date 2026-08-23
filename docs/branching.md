# Branching & Release Workflow

Date: 2026-08-23
Status: active

## Overview

The `ta_vibehive` repository uses a two-branch flow:

- **`main`** — production. Everything that lands here auto-publishes:
  - `pages.yml` rebuilds `https://tadeskops.github.io/ta_vibehive/`.
  - `deploy-worker.yml` deploys `worker/` to Cloudflare (only when `worker/**` changed).
  - Scheduled crons (`reports-cron.yml`, `feature-audit-save.yml`) check out the default branch (`main`) and run against production data.

- **`dev`** — active development. Everything that lands here is safe:
  - No production deploy is triggered.
  - CI still runs on every push (`ci.yml` push triggers now include `dev`) so integrity checks and the feature-coverage audit validate your work before it ever reaches `main`.

The current release anchor is [`v1.0.0`](https://github.com/tadeskops/ta_vibehive/releases/tag/v1.0.0), created from `main` at commit `daf7fa9`. The `dev` branch was created from that same tag so both branches share history.

## Which workflow runs on which branch?

| Workflow | `push: main` | `push: dev` | PR → `main` | Schedule | Publishes to production? |
|---|:---:|:---:|:---:|:---:|:---:|
| `pages.yml` | ✅ | ❌ | — | — | ✅ (only from `main`) |
| `deploy-worker.yml` | ✅ (if `worker/**`) | ❌ | — | — | ✅ (only from `main`) |
| `ci.yml` | ✅ | ✅ | ✅ | — | ❌ (verification only) |
| `reports-cron.yml` | — | — | — | ✅ hourly | reads production repo, writes to `docs/ops/live-reports/` on default branch |
| `feature-audit-save.yml` | — | — | — | ✅ weekly | writes `docs/ops/feature-audit-latest.md` on default branch |
| `sync-worker-secrets.yml` | — | — | — | manual `workflow_dispatch` | Cloudflare secrets sync — manual only |

**Key guarantees**:
1. Pushing to `dev` cannot change what visitors see at `https://tadeskops.github.io/ta_vibehive/`.
2. Pushing to `dev` cannot change what the Cloudflare Worker responds with.
3. Pushing to `dev` still runs `ci-verify.mjs` and `feature-audit.mjs` so broken code never reaches `main` unnoticed.

## Daily development loop

```powershell
# One-time: make sure your local dev tracks origin/dev
git fetch origin
git checkout dev
git pull --rebase origin dev

# Work
# … edit, save, run node --check on any JS you touched …
git add <files>
git commit -m "type(scope): message"
git push origin dev
# → CI runs on dev. Watch it at
#   https://github.com/tadeskops/ta_vibehive/actions
# → Pages and Worker are UNCHANGED (they only publish from main).
```

## Promotion loop (dev → main)

Only run this once a feature slice on `dev` is validated (CI green + local browser smoke + any manual checks needed).

### Option A — Direct fast-forward merge (simple, no PR review)

```powershell
git checkout main
git pull --rebase origin main
git merge --no-ff dev -m "release: promote dev → main"
git push origin main
# → pages.yml and (if worker/** changed) deploy-worker.yml fire automatically.
# → Site refreshes in ~1-5 min. Check `BUILD.txt` at the site root to
#   confirm which deploy is live.
```

### Option B — Pull request (recommended, keeps the audit trail)

```powershell
# Push dev as usual, then on GitHub:
#   https://github.com/tadeskops/ta_vibehive/pull/new/dev
# The PR runs ci.yml against main automatically.
# Review, merge, and pages.yml + deploy-worker.yml fire on the merge.
```

## Tagging a release

After a promotion that ships a coherent set of changes, tag `main`:

```powershell
git checkout main
git pull --rebase origin main
git tag -a v1.1.0 -m "Release notes here…"
git push origin v1.1.0
```

Tags are immutable references; use `v1.x.y` semver so anyone can `git checkout v1.0.0` and get exactly what shipped on 2026-08-23.

## Why merging validated `dev` into `main` cannot break production

The safety comes from the fact that **Git merge preserves the file tree**, not just a summary of it:

1. **Same source tree.** The commit created by `git merge --no-ff dev` on `main` points at the exact same tree of files that was verified on `dev`. There is no rebuild, transpile, or transform step between "CI passed on `dev`" and "Pages deploys the merged commit". `pages.yml` copies `index.html`, `404.html`, `assets/`, `config/`, and (if present) `robots.txt` verbatim from the checked-out tree into `_site/` before publish.
2. **Same CI.** Every `dev` push now runs the same `ci.yml` job. If it passes on `dev`, it will pass on the merge commit — the check is deterministic (integrity + feature-coverage + gitleaks) and doesn't depend on which branch it runs from.
3. **No hidden path rewrites.** The site uses hash-based routing (`#/reports`, `#/e/:id`) and relative asset paths. Nothing depends on being served from a specific branch or path; the pages workflow doesn't set a base URL.
4. **`worker/` is path-gated.** `deploy-worker.yml` only deploys when the merge commit touches `worker/**`. Pure client-side changes (which is the vast majority) don't touch the Worker at all, so its runtime is unaffected until you deliberately ship a Worker change.
5. **Scheduled crons use the default branch.** The default branch is `main`. As long as you keep it there, the hourly reports cron continues running against the production tree, not against `dev`.
6. **`_dev/` is gitignored.** The local dev sign-in harness under `ta_vibehive/_dev/signin.html` is excluded from every commit and every Pages artifact. It cannot leak into production even by accident.

Concrete implication: if `dev` at commit X passes CI and looks correct in your local browser at `http://localhost:8091/`, the merge commit on `main` will deploy the same tree and produce the same behaviour at `https://tadeskops.github.io/ta_vibehive/`. The only lag is GitHub Pages' CDN cache (~1–5 min after `pages.yml` finishes).

## What to watch for after every merge to `main`

1. **Actions tab** — [https://github.com/tadeskops/ta_vibehive/actions](https://github.com/tadeskops/ta_vibehive/actions) — confirm `Deploy to GitHub Pages` finished green.
2. **`BUILD.txt` sanity check** — `curl -s https://tadeskops.github.io/ta_vibehive/BUILD.txt` prints the UTC timestamp of the most recent Pages deploy. If it hasn't updated after ~5 min, something failed.
3. **Worker (if `worker/**` changed)** — check `Deploy Worker` job status. If Cloudflare deploy failed, the previous Worker version keeps serving. No half-deploys.
4. **Live smoke** — open the deployed site in a fresh browser (or incognito) and hit the routes you changed.

## Emergency rollback

If a merge to `main` produces broken behaviour on the deployed site:

```powershell
# Revert the merge commit (keeps history intact)
git checkout main
git pull --rebase origin main
git revert -m 1 HEAD                # -m 1 keeps the "main" parent
git push origin main
# → pages.yml fires again with the pre-merge tree.
```

For the Worker, `wrangler rollback` from the `worker/` folder rolls back the most recent deploy.

## Rules of the road

- **Never push directly to `main`.** Use the promotion loop.
- **Keep the default branch as `main`.** Scheduled crons rely on it.
- **Don't delete the `dev` branch** even after a merge — it's the ongoing integration branch, not a feature branch.
- **Tag `main` after every release-worthy promotion** (`v1.1.0`, `v1.2.0`, …) so you can `git checkout <tag>` if you ever need to compare.
- **`_dev/` stays gitignored.** If you need a new local harness, add it under `_dev/` — never under `assets/` or the repo root.
