# Automation and Persistence Policy

Date: 2026-08-22
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

## Current mandatory repo-gated saves

1. Event create/edit/publish save.
2. Settings Attributes "Save all settings changes".
3. Receipt Templates "Save all template changes".
4. Expense Preferences "Save expense preferences".

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

## Operator checklist before launch

1. Archive repo + PAT configured in settings.
2. Archive enabled.
3. Outbox empty after a manual flush.
4. CI verify workflow green.
5. Feature audit has 0 must-live unwired rows.
6. `TVH_ARCHIVE_PAT` secret is set in GitHub Actions.
7. `config/reports-cron.json` is reviewed for desired timezone and export hours.
