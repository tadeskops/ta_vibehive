# Automation and Persistence Policy

Date: 2026-08-23
Status: active

## Goal

Ensure production data is not local-only. Browser local state can be used for draft UX, but final Save actions must persist to the repository archive path.

## Rules

1. Local-only is allowed only for transient draft state and offline queue buffers.
2. Any explicit Save button that changes functional configuration or event data must:
- batch the staged changes,
- attempt repository archive push in the same flow,
- rollback local write if archive push fails,
- show explicit error when archive is not configured/enabled.
3. Save buttons should remain consolidated where possible (single commit action per panel/tab).
4. Archive queue fallback remains valid for telemetry/history/report snapshots, but critical user-facing Save flows must be repo-gated.
5. **Destructive local-first actions are the only exception**, and only when the destructive intent is bounded to the local browser (see "Documented local-only exceptions" below).

## Current mandatory repo-gated saves

1. Event create/edit/publish save.
2. Settings Attributes "Save all settings changes".
3. Receipt Templates "Save all template changes".
4. Expense Preferences "Save expense preferences".

## Documented local-only exceptions

The following destructive actions are intentionally NOT repo-gated. Each writes a local audit entry so the who/when is preserved even though the archive repo is not touched:

1. **Admin Purge for Closed / Archived Events** (`assets/js/events.js#purgeEvent`, admin-only, see `docs/requirement.md` §16).
   - Removes the event and every row that references it from local state (contributions, expenses, event history, audit rows).
   - Writes a single `event.purge` audit entry with counts.
   - Adds the event id to `state.purgedEvents()` at `tvh:v1:purgedEvents`; `sync.js` filters `listEvents()` through that blocklist so a stale archive-repo copy cannot zombie-resurrect the event on the next hydrate.
   - Manual clean-up of the archive repo (`tvh_record/events/<slug>/…`) is out of scope for the client and must be done separately by a repo admin.

## CI expectations

1. Feature coverage audit must run on push/PR.
2. Must-live feature IDs must not be unwired.
3. Dangerous DOM sinks (`document.write`, `eval`, `new Function`, `innerHTML`, `outerHTML`) are CI blocking.
4. Weekly feature-audit snapshot is committed automatically.
5. Live-event contribution report snapshots are exported by background workflow and committed automatically to tracked docs paths (no local-only reporting source of truth).

## Scheduled export policy

1. Workflow: `.github/workflows/reports-cron.yml` executes hourly and gates actual exports via `config/reports-cron.json`.
2. Frequency is configurable in `config/reports-cron.json` by local hour list (`run_hours_local`).
3. Current default is three runs per day in IST (`06`, `14`, `22`).
4. Output path is tracked: `docs/ops/live-reports/` (`latest.*` and timestamped snapshots).
5. Workflow dispatch supports `force_run=true` for manual backfill.
6. Secret `TVH_ARCHIVE_PAT` is required to read the archive repository source data.

### Known coverage gaps in the scheduled export

- `scripts/generate-reports.mjs` currently reads **only** receipt archive entries (verified contributions). The browser Reports page has since gained an `Include expenses` toggle + `Expense status` filter (see `docs/requirement.md` §20) that the cron does not yet honour. Extending the cron to walk `expenses/` archive paths alongside `receipts/` is tracked as a follow-up so the automated report shape can match the interactive report shape.
- The visitor counter (`worker/src/routes/metrics.ts`) commits `data/visitors.json` on its own hourly cadence and via the Worker's scheduled handler; it is not part of the reports cron and does not need to be.

## Operator checklist before launch

1. Archive repo + PAT configured in settings.
2. Archive enabled.
3. Outbox empty after a manual flush.
4. CI verify workflow green.
5. Feature audit has 0 must-live unwired rows.
6. `TVH_ARCHIVE_PAT` secret is set in GitHub Actions.
7. `config/reports-cron.json` is reviewed for desired timezone and export hours.
8. Confirm no closed/archived sample events remain in the archive repo before launch. If an admin runs the danger-zone Purge to clean up in-browser, a repo admin should also delete the matching `tvh_record` folders so future hydrates do not surface a stale copy that then gets blocklisted.
