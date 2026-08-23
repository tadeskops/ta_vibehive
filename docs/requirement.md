# VibeHive Implemented Requirements (Current State)

Date: 2026-08-22
Scope: This document reflects what is implemented in the current ta_vibehive codebase, not planned roadmap items.

## 1) Access and Roles

Implemented:
- Role hierarchy includes `admin`, `secretary`, `mgmt`, `committee`, `manager`, `resident`.
- Permission matrix is enforced through RBAC checks per action.
- Secretary role is positioned below admin and above other operational roles.
- Header identity block renders role chip with sign-in/sign-out controls.

Config source:
- `config/roles.json`

## 2) Feature Registry and Event Scoping

Implemented:
- System and event-scoped feature flags are defined in a central registry.
- Event editor supports per-event feature toggles with dependency checks.
- Governance toggles for event history and event report list view are persisted and synced into event feature flags.
- `reporting.export` is explicitly registered as a system feature and defaults ON, so Reports builder is available unless an admin disables it in Feature registry.

Config source:
- `config/features.json`

Core implementation:
- `assets/js/features.js`
- `assets/js/views/event.js`

## 3) Event History Governance

Implemented:
- Moderator history recording can be enabled per event.
- History visibility/configuration is restricted to MC/Secretary/Admin via permissions.
- History entries are stored locally and also routed to archive pipeline.

Core implementation:
- `assets/js/events.js`
- `assets/js/views/event.js`
- `assets/js/store.js`

## 4) Event Contribution List Report Access

Implemented:
- Event-specific signed-in list report route: `#/reports/event/:id`.
- Route is gated by event-level feature enablement and permission/allowlist checks.
- Optional resident allowlist restriction is supported.
- Report export includes event-based selection so roles with `reports.export` permission can choose a specific event from a list that includes both live and past events, then download/archive that event report as PDF.

Core implementation:
- `assets/js/views/reports.js`
- `assets/js/events.js`

## 5) Resident Email Governance and Role Mapping

Implemented:
- Gmail allowlist parser accepts newline/comma/semicolon/space separators.
- Role-to-email mapping supports one-or-more email IDs per role.
- Settings now uses a simple direct role-to-email editor (one list per role) instead of tier/rank configuration.
- Role mapping editor is presented as a vertical click-to-expand list (one role card at a time) for easier member management.
- Backward-compatible email-to-role index is maintained for runtime lookup.
- Attributes-tab settings edits are staged and committed through one consolidated "Save all settings changes" action.
- Receipt templates and expense preferences support explicit staged Save/Discard actions.
- Governance guardrails:
  - Admin can add/remove/modify mappings for all roles.
  - Secretary and Management Committee can add/remove/modify mappings for non-admin roles.
  - Secretary and Management Committee cannot edit admin role mappings.
- Allowlist and mapping are persisted in society overrides.

Core implementation:
- `assets/js/views/settings.js`
- `assets/js/auth.js`

## 6) Footer Visibility Controls

Implemented:
- Desktop footer visibility toggles are available for social, bug report, verify link, legal line, and source line.
- Runtime footer reflects configured toggles.
- Footer brand row keeps society name visible, while source/build chips are independently configurable and disabled by default.
- Verify receipt entry points are configuration-driven and default to disabled (`navigation.show_verify = false`).
- Desktop footer suppresses the verify action and source/meta row to keep desktop chrome minimal.

Current enforced behavior:
- Desktop legal/source meta lines are intentionally suppressed from the end-user footer UI.
- Desktop footer verify action is intentionally suppressed from the end-user footer UI.
- Source/build chips in the brand row can be enabled from Settings when needed.

Core implementation:
- `assets/js/views/settings.js`
- `assets/js/app.js`
- `config/society.json`

## 7) Contribution Flow and Data Safety

Implemented:
- Contribution form includes note/remarks and validation helpers.
- Per-event draft cache survives refresh and is cleared on successful submit.
- Event create/edit/publish writes fail-fast when local browser storage is blocked/full, with explicit error feedback instead of silent success.
- Event create/edit/publish is repository-gated: save succeeds only after archive commit succeeds. If archive push fails or archive is not configured/enabled, local event changes are rolled back and user sees an explicit error.
- Settings save actions are repository-gated for attributes, templates, and expense preferences: each Save button batches staged changes, pushes archive snapshot(s), and rolls back local writes on archive failure.
- Settings -> Attributes exposes archive controls (`receipts.archive_repo`, optional fallback repo, `receipts.archive_branch`, `receipts.archive_pat`, and archive enabled toggle) so operators can configure remote persistence without code edits.
- If archive persistence is missing/disabled during template-based event creation, the flow redirects to Settings -> Attributes with a setup hint instead of leaving the user stuck on the template modal.
- One-contribution-per-flat event rule is supported and enforced at storage guard level.
- Event creator can set/edit suggested contribution amounts per event using one-by-one add/remove rows (any count); these values drive resident quick-tap amount chips.
- Event creator can set/edit an optional appreciation note template per event; contribute page renders it dynamically using selected amount placeholder (`{amount}`).
- Mobile/quick-action `+` is create-only (new event) and is shown only when `events.create` permission is granted via role/configuration.
- Quick-action stack popup UI is currently disabled (kept in code), and tapping `+` directly routes to event creation flow.
- Contribution payment UX currently runs in manual UPI mode:
  - Configured UPI ID is displayed for external app payment.
  - Society can attach a UPI QR image from Settings (stored inline) in addition to path-based QR fallback.
  - Residents can view and save the payment QR to phone directly from the contribute flow.
  - Resident submits UTR/proof for committee verification.
  - Auto-capture from UPI apps and auto-receipt on payment callback is not relied on in current static flow.
- Resident-facing help note is shown for manager/committee assisted upload/update intent.

Core implementation:
- `assets/js/views/contribute.js`
- `assets/js/events.js`
- `assets/js/store.js`

## 8) Receipt ID and Receipt Archive

Implemented:
- Event-based receipt ID format using time components and collision fallback.
- Automated receipt naming pattern: `<EVENT_TYPE>-<YYYYMMDD>-<HHMM>` derived from event cluster/type + verification timestamp (e.g. `FESTIVAL-20260822-1430`). Seconds and a short SHA salt append only on collision.
- Verified receipt generation stores verification hash and archive metadata.
- Immediate archive push is attempted on write. For event save operations, archive success is mandatory and is treated as the authoritative write gate.

Core implementation:
- `assets/js/receipts.js`
- `assets/js/archive.js`
- `assets/js/archive-runtime.js`

## 9) Direct Immediate Write to tvh_record

Implemented:
- Archive pipeline supports immediate push for:
  - Event snapshots (on event create/edit/publish/save)
  - Receipt records
  - Event moderator history records
  - Report snapshots
- On push failure, drained entries are re-queued automatically.
- Manual retry is available via Admin → Society settings → Flush archive queue.

Required runtime settings:
- `receipts.archive_repo`
- `receipts.archive_repo_fallback` (optional secondary target; used when primary push fails)
- `receipts.archive_branch` (default `main`)
- `receipts.archive_pat` (fine-grained token with repo contents read/write)

Core implementation:
- `assets/js/archive-runtime.js`
- `assets/js/events.js`
- `assets/js/views/admin.js`
- `assets/js/views/reports.js`
- `assets/js/receipts.js`

## 10) Validation Status (Current)

Completed validation:
- Static diagnostics: no JS diagnostics in changed feature files.
- Live browser smoke (localhost):
  - Role-gated admin/settings pages render correctly.
  - Event creation/edit/publish flow works.
  - Event report list route now works after enabling event-level report toggle.
  - Reports page no longer renders literal `null` nodes.
  - Header border glow is visible across view transitions and backend/network progress states.
  - Save actions on settings tabs trigger the global progress indicator.
  - GitHub Actions coverage:
    - `.github/workflows/ci.yml` now runs repository integrity checks plus automated feature-coverage audit on push/PR and publishes the audit in step summary + artifact.
    - `.github/workflows/feature-audit-save.yml` now snapshots feature coverage weekly into `docs/ops/feature-audit-latest.md` and commits updates when changed.
    - `config/feature-traceability.json` declares must-live features and feature-to-file mapping; CI fails only when a must-live feature becomes unwired.
    - `docs/automation-policy.md` defines the no-local-only final save policy and launch checklist.

Known non-blocking browser message:
- CSP `frame-ancestors` warning when delivered via meta tag in localhost context. This does not block app flows.

## 11) Out of Scope / Not Yet Implemented Here

Not included in this implemented-state document:
- OTP backend/email-provider workflow
- Public receipt verification backend expansion beyond current local path
- Multi-language content rollout
- Other roadmap-only items listed in README roadmap

## 12) Admin and Settings Dense Grid Defaults

Implemented:
- Grid-heavy sections in Admin are rendered as collapsible panels and start collapsed by default (including Feature registry clusters and Admin settings sections).
- Resident email governance grid section in Settings starts collapsed by default.
- Sections remain expandable on demand without changing role/permission behavior.
- Roles and permission matrix in Admin are rendered in transposed role-first form for improved readability.

Core implementation:
- `assets/js/views/admin.js`
- `assets/js/views/settings.js`
- `assets/css/base.css`

## 13) Discoverability, Navigation & Download UX

Implemented (2026-08-23):

**Alt-key tooltip broadcast** — holding the `Alt` key pins every visible
`title` / `aria-label` tooltip in the viewport as a floating pill and
releases them on `Alt` keyup / window blur. No native OS bubbles, no
noise; power users see every icon's purpose at once for orderly
operation. Text-input focus is excluded so form typing is untouched.

**Breadcrumb trail** — a slim breadcrumb above the stage on every page
except Home, showing `Home › Events › <Event title>` etc. Resolves
human labels from local state (event titles). Feature-gated by
`society.ui.breadcrumbs` (default `true`); set to `false` to hide on
both desktop and mobile.

**Direct receipt download** — the inline `⬇` icon on the Home dashboard
and Event contributor board no longer routes to the receipt preview.
It opens a small popover with `PDF (A4)` and `PNG image` options and
downloads the chosen format directly. This eliminates the double-hop
(list → preview → auto-download) and lets residents/committees pick
the lighter PNG when repo-space matters. Preview page also gained the
format selector and no longer auto-downloads on `?download=1`.

**Visit card on mobile** — daily and all-time unique visitor counts
are now shown side-by-side on the Home dashboard for phones. The
footer chip stays as the desktop-only mirror.

Core implementation:
- `assets/js/longpress-tooltip.js` — Alt-key broadcast
- `assets/js/breadcrumb.js` + `config/society.json` (`ui.breadcrumbs`)
- `assets/js/receipt-download-menu.js` — format popover
- `assets/js/views/receipt.js` — `downloadReceiptImage` + `downloadReceiptDirect` + format selector
- `assets/js/visit-counter.js` — split today / all-time layout
- `assets/css/base.css`

## 14) Automated Reports & Receipt Archival

Implemented (2026-08-23):

**Per-event JSON reports (daily, change-driven)** — on Home mount for
users with `reports.export`, the app walks every published + closed
event and:
1. Builds a compact JSON snapshot (event meta + contributions +
   expenses + verified/pending/net totals + unique-flat count).
2. Content-hashes the payload with SHA-256.
3. Skips the write if the hash matches the last archived version OR
   the last write is younger than 20 h.
4. Otherwise pushes to the private records repo under
   `reports/<eventCodeLower>/<societyPrefix>_<eventCode>_<DDMMYYYY>_<HHMMSS>.json`
   e.g. `reports/fest/TA_FEST_23082026_143502.json`.
5. Persists the hash + path in `overrides.reports.state[eventId]` so
   we never double-write.

Naming convention:
- `<societyPrefix>` — from `society.receipts.prefix`
  (e.g. `TA`), sanitised to `[A-Z0-9]{1..8}`.
- `<eventCode>` — first 4 chars of `event.template` upper-cased
  (`FEST`, `SOC`, `SPRT`, `DON`, `EMER`, `INFR`, …).
- `<DDMMYYYY>_<HHMMSS>` — local time of generation.

**Auto-archive of receipt PDFs** — every download via `downloadReceiptPdf`
still calls `archivePdfIfMissing` (idempotent) so freshly minted
receipts land in `tvh_record` even when a resident downloads them.

Configuration:
- `society.receipts.archive.enabled` gates all archive writes.
- `society.receipts.archive.perReceiptPath` template drives the
  per-receipt PDF path (existing).

Core implementation:
- `assets/js/daily-reports.js` — `runDailyReportsBackfill`
- `assets/js/archive-runtime.js` — `queueAndMaybePushArchive`,
  `archivePdfIfMissing`
- `assets/js/views/home.js` — mount-time invocation gated by RBAC
