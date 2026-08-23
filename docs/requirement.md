# VibeHive Implemented Requirements (Current State)

Date: 2026-08-23
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
- Contribution payment UX currently runs in manual mode with a tabbed Online / Cash flow:
  - **Payment type** is a two-tab segmented control on the contribute form (Online, Cash). Panels swap in place — one payment type is visible at a time.
  - **Online tab** — pay via UPI or bank transfer. When both are enabled a sub-radio chip (UPI · Bank transfer) picks the kind; otherwise the enabled kind is auto-selected. The society/event's UPI ID + QR (or bank details) are shown in a pay-guide callout. Residents supply EITHER a **Transaction number** (UPI UTR / NEFT ref) OR upload a **Payment proof** (screenshot / PDF) — at least one is required; both cannot be blank. Stored `method` = `'upi'` or `'bank'`.
  - **Cash tab** — residents hand cash/cheque to a committee member and record **Paid to (name)** (mandatory), **Paid to (mobile)** (mandatory, 10-digit), and **Paid to (flat)** (optional). Stored `method` = `'other'` with populated `paid_to_name`, `paid_to_mobile`, `paid_to_flat` fields on the contribution record. Online submissions leave those fields empty.
  - **Comment (optional)** textarea works for both payment types — for anything the committee should know (name spelling, later-update requests, etc.).
  - Residents can view and save the payment QR to phone directly from the contribute flow.
  - Resident submission stays `pending` until a committee member verifies from Manage / Approvals.
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

## 15) Per-Event Receipt Theme

Implemented (2026-08-23):

**Event creator picks the receipt theme** — the event editor
(`renderEdit` in `assets/js/views/event.js`) gained a "Receipt theme
(optional)" field with the three shipped themes:
- Default · Community Warmth
- Cheque Classic · blue grid
- Certificate Brand · indigo + gold

Left blank, the receipt inherits the society-wide default. The
chosen theme is persisted on the event as `evt.receipt_theme` and is
the primary source used by every receipt download for that event.
A small hint under the picker explains each theme; a "Preview →"
link opens the corresponding shipped preview asset in a new tab so
committee members can eyeball the layout before publishing.

**Residents never see the theme picker** — the picker on the receipt
preview page is gated by both:
1. `receipts.theme.override` capability (already admin/secretary/mgmt),
2. an explicit `user.role !== 'resident'` guard (belt-and-suspenders).

Residents (and any other role without the capability) silently use
whichever theme the event creator selected, so their downloaded
receipt looks exactly like the moderators intended.

**Theme resolution precedence** at download time:
`evt.receipt_theme` → active shipped template → `society.receipts.default_theme` → `default`.

Core implementation:
- `assets/js/views/event.js` — event editor `themeI` field +
  `receipt_theme` on the save payload.
- `assets/js/views/receipt.js` — `defaultTheme` and
  `downloadReceiptDirect` both prefer the event-level theme.
- `config/roles.json` — `receipts.theme.override` remains
  `[admin, secretary, mgmt]`.

## 16) Admin Purge for Closed / Archived Events

Implemented (2026-08-23):

**Danger-zone card on the Event admin view** — admins (and only
admins) see a red `⚠ Danger zone` card at the bottom of
`#/e/:id/manage` **but only when the event's status is `closed` or
`archived`**. The card states the exact record counts that will be
deleted (contributions, expenses, history entries, matching audit
rows) and requires the admin to type the event title verbatim
before the `Purge event & all records` button unlocks.

**What Purge removes** (all local, atomic per call):
- The event from `state.events()`.
- Every `state.contribs()` row whose `event === id`.
- Every `state.expenses()` row whose `event_id === id`.
- Every `state.eventHistory()` row whose `event === id`.
- Every `state.auditLog()` entry that references the event id, or
  the id of any contribution / expense just removed.

**What Purge writes**:
- A single `event.purge` audit entry with `actor`, `event`,
  `event_title`, and the counts of removed rows, so after-the-fact
  who-did-what visibility is preserved.
- The event id lands in `state.purgedEvents()` at
  `tvh:v1:purgedEvents`. The sync loop in `assets/js/sync.js`
  filters `listEvents()` output through that blocklist so a stale
  archive-repo copy cannot zombie-resurrect a purged event on the
  next hydrate.

**Guardrails**:
- Non-admin actors are rejected client-side (`actor.role === 'admin'`
  precondition throws a friendly error before any writes).
- Events with any status other than `closed` or `archived` are
  rejected — an active event cannot be purged by mistake.
- The type-the-title confirmation input makes single-click accidents
  impossible.
- On success the app navigates to `#/events` and toasts the counts.

Core implementation:
- `assets/js/events.js` — `purgeEvent(eventId, actor)`
- `assets/js/store.js` — `purgedEvents`, `isEventPurged`,
  `markEventPurged`
- `assets/js/sync.js` — blocklist filter in the event-hydrate step
- `assets/js/views/event.js` — `renderDangerZone(evt, user)` and
  the admin+closed/archived gate in `renderManage`
- `assets/css/base.css` — `.tvh-danger-zone` + disabled state for
  `.btn-emerg`

## 17) Home Dashboard — Mobile Grid & Committee Tile Removal

Implemented (2026-08-23):

**Committee tile removed** — the `Committee · Cultural · Sports ·
Volunteers` KPI card in the signed-in dashboard grid and the
matching hero chip strip (`.tvh-hero-chips`) were both dropped from
`home.js`. The signed-in KPI grid now runs three tiles: `Live
events`, `Contributors`, `Collected`.

**KPI grids pack 2-per-row on 390 px** — the mobile breakpoint in
`base.css` was tightened so tiles adapt to their content instead of
stacking one-per-row:
- `.grid-4` mobile: `minmax(130px, 1fr)` (was 150 → 1 col on 315 px
  parent; now 2 cols).
- `.tvh-kpi-grid` mobile: `minmax(110px, 1fr)` with slightly
  smaller padding and `.tvh-kpi-v` font size.

Result: the event-spotlight KPI grid (`Raised / Pending /
Contributors / Net`) renders as a 2×2 dashboard on mobile instead
of a 4-tall stack.

Core implementation:
- `assets/js/views/home.js`
- `assets/css/base.css`

## 18) Visitor Counter — Server-Side Per-Day Uniqueness

Implemented (2026-08-23):

**Semantics** (visible in the footer chip and the mobile home card):
- `today` = **unique signed-in visitors for the current UTC day**.
  Same person on two devices counts once.
- `total` = accumulated sum of daily uniques. Someone who visits on
  three different days contributes 3 to the total — by design,
  `total` is NOT a distinct-humans-ever figure.

**Server-side dedup** — `worker/src/routes/metrics.ts` now persists:
- `today_date: "YYYY-MM-DD"` — the UTC day the identity set covers.
- `today_visitors: string[]` — lower-cased caller identities seen
  today, capped at `MAX_TODAY_VISITORS = 5000` per day.

`POST /metrics/visit`:
- Anonymous callers (no `ctx.identity`) → returns current counts,
  **does NOT bump**.
- Signed-in caller already in the day's identity set → returns
  current counts, does NOT bump.
- New signed-in caller → adds identity to the set, increments
  `by_day[today]` and `total`.

On cold start the in-memory set hydrates from `today_visitors` if
the persisted `today_date` matches today; otherwise it's cleared.

**Client** (`assets/js/visit-counter.js`) keeps its per-user-per-day
LocalStorage bump-marker as an optimisation to avoid needless POSTs;
the server is the source of truth for uniqueness. Card labels are
`Unique today` / `Total so far`; tooltip explains the semantics.

Core implementation:
- `worker/src/routes/metrics.ts`
- `assets/js/visit-counter.js`

## 19) Approvals & Event admin — Responsive Card Reflow

Implemented (2026-08-23):

**Two-tab navigation clarity**:
- `#/manage` — cross-event **Approvals inbox** (renders as
  `Approvals`).
- `#/e/:id/manage` — per-event **Event admin** (renders as
  `Event admin · <title>`, with an `→ All approvals` link back to
  the cross-event inbox).
Both surfaces share the same verify / void pipelines.

**Mobile-safe table reflow** — the 7- and 8-column pending
contribution / pending expense tables previously squeezed each
column to ~40 px on a 390 px viewport and forced text to wrap one
character per line. Fix in two pieces (no per-view code changes):

- `assets/js/dom.js` — `mount()` now runs
  `applyResponsiveTableLabels(root)` after appending children. It
  walks every `table.table` in the mounted subtree and stamps each
  `<td>` with a `data-label` attribute derived from the
  corresponding `<th>`. Views that call `mount()` (`event.js`, most
  views) get it for free. `manage.js` bypasses `mount()` inside its
  `draw()` loop and calls the helper explicitly.
- `assets/css/base.css` — `@media (max-width: 640px)` reflow:
  `.table` becomes `display: block`, `thead` hides, each `<tr>`
  becomes a 2-column CSS grid with the stamped `data-label` as an
  uppercase caption above each value. Compound cells (`Contributor
  / Event`, `Category / Event`, `Description`, `Ref / proof`,
  `Actions`, `Note / detail`, `Subject`, `Note`) span the full row.
  Buttons in the `Actions` cell wrap with `gap: 6px` rather than
  shrinking. Empty-state placeholder rows span the whole card and
  centre their text.

**Access gates unchanged**:
- Residents visiting `#/manage` get a `Not authorised` card
  (`contributions.verify` or `expenses.verify` required).
- Non-admin roles never see the danger-zone card on
  `#/e/:id/manage` regardless of viewport (see §16).

Core implementation:
- `assets/js/dom.js` — `applyResponsiveTableLabels`
- `assets/js/views/manage.js` — cross-event Approvals inbox
- `assets/js/views/event.js` — per-event Event admin `renderManage`
- `assets/css/base.css`

## 20) Reports — Include-Expenses Toggle & Expense-Status Filter

Implemented (2026-08-23):

Reports previously had two hardcoded assumptions the treasurer
could not override:
1. Expenses were always mixed into the summary + PDF header.
2. Only verified expenses were ever counted.

Both are now user-adjustable and persist under the reports filter
LocalStorage key (`tvh:v1:reports:filters`), so the same choices
propagate to the on-screen preview, the downloaded PDF, and the
archive snapshot (via the shared `scopedExpensesFor()` helper).

**New Expenses filter section** on `#/reports`:
- `Include expenses against these events (recommended)` checkbox,
  default **ON**. Turning it OFF cleanly removes the Expenses
  summary block and the PDF's second header line.
- `Expense status` set (`pending` + `verified`) appears when
  include is ON. Default = **verified only**. A safeguard forces
  `verified` back on if the user unticks both, so "Include with no
  filter" cannot accidentally hide all expenses.
- The contribution status section was renamed from `Status` to
  `Contribution status` so the two filter blocks are unambiguous.

**Summary label** now reads `Expenses in scope (N rows · <filter> ·
Rs.X verified spent · Rs.Y net)` with an inline note when pending
rows are included but not yet counted in Net. The category
breakdown table gains a `Verified ₹` column so verified vs total
per category is visible at a glance.

**PDF header** second line mirrors the same shape — `Expenses N
(<filter>) · Spent Rs.X verified · Net Rs.Y` — so PDF and screen
always show matching numbers.

**Empty-scope fallback**: `No expenses match the current scope +
status filters.` replaces the previous silent dead-space when
include is on but the filter matches nothing.

**Automation gap (open item)**: the 3×/day scheduled cron at
`.github/workflows/reports-cron.yml → scripts/generate-reports.mjs`
still reads only receipt archive entries (verified contributions);
extending it to walk the `expenses/` archive path alongside
`receipts/` is a follow-up task.

Core implementation:
- `assets/js/views/reports.js` — new state fields
  `includeExpenses`, `expenseStatuses`; `scopedExpensesFor()`
  helper used by the summary and the PDF builder.

## 21) Contributor Board — Resident Amount Mask (Configurable)

Implemented (2026-08-23):

**New event-scope feature flag**: `privacy.mask_amounts_resident`
(default OFF, opt-in per event via the event editor's feature
toggles). When ON, the Contributor board renders a subtle
`•••` chip in place of the amount for signed-in residents who are
looking at other people's contributions.

**Behaviour matrix**:
- **Resident viewing their own row** → real amount (identified by
  `ownsRow(r)`: contributor email, id, `created_by`, `filled_by_email`,
  or lower-cased name match).
- **Resident viewing others' rows** → `•••` chip with
  `title="Amount hidden"`; the underlying DOM does not carry the
  numeric value.
- **Committee / manager / mgmt / admin** → all amounts visible;
  the flag has no effect on non-resident roles.
- Dashboard tally stats (`Goal`, `Raised`, `Contributors`,
  `Time left`) are **not** affected — only per-row amounts are
  redacted, so aggregate transparency is preserved.

**Relationship to existing privacy flags**:
- `privacy.public_board` (event) — turns the board on/off entirely.
- `privacy.amount_hidden` (event) — hides amounts for **everyone**
  on the board (existing behaviour, unchanged).
- `privacy.mask_amounts_resident` (event, new) — resident-only
  redaction that keeps committee visibility.
- Per-row `c.hide_amount` (contributor's own opt-out) — still
  overrides the amount to em-dash regardless of role.

The board header adds a one-line explainer to residents when the
flag is on, so the mask is clearly labelled rather than mistaken
for missing data.

Core implementation:
- `config/features.json` — flag registration + human label.
- `assets/js/views/event.js` — `renderPublicBoard()` gains a
  `maskAmountsForResidents` opt; `amountCell(r)` picks between the
  em-dash / mask chip / plain value; `shouldMaskAmount(r)` reuses
  the existing `ownsRow(r)` helper.
- `assets/css/base.css` — `.tvh-amount-masked` chip.

## 22) Session-Level Mobile Hardening (Rolling)

Implemented (2026-08-23):

Small mobile polish shipped alongside larger features:

- **Long path / URL wrapping** — `.field code`, `.panel code`,
  `code.sub`, `pre.sub` and text inputs on the Settings / Reports /
  Receipt views now `word-break: break-all; overflow-wrap:
  anywhere; max-width: 100%` so paths like
  `reports/festival/TA_FESTIVAL_.../…report.json` never blow the
  viewport past 390 px.
- **Contribute view defensive tiers** — `assets/js/views/contribute.js`
  guards `evt.tiers` with `Array.isArray(evt.tiers) ? evt.tiers : []`
  so events created / migrated / hand-edited without a `tiers`
  field no longer crash the form with `TypeError: Cannot read
  properties of undefined (reading '0')`.
- **Floating progress ring** — top-right rotating ring surfaces a
  human-readable label whenever `busy.on()` fires so users know a
  network / archive operation is in flight.
- **About modal expansion** — the About Samana Sippa Labs modal
  documents the six core pillars, the guiding principle, and how
  VibeHive lives them.
- **`_dev/` gitignore** — the local dev sign-in harness lives at
  `ta_vibehive/_dev/signin.html` and is ignored from git; it lets
  contributors exercise resident / committee / admin flows without
  the real Google OAuth loop, but is never deployed.

Core implementation:
- `assets/css/base.css` — long-path wrapping rule
- `assets/js/views/contribute.js` — `Array.isArray` guard
- `assets/js/about-modal.js`, `assets/js/app.js`, `index.html` —
  progress ring + About modal
- `.gitignore` — `_dev/` entry


## 23) Event Operations Workspace (Phase 1)

Implemented (feature branch `feature/eventOperations`, 2026-08-23):

**Objective** — a per-event visual command centre that lets the
Cultural Committee plan, delegate, monitor, and execute a multi-day
event (e.g. a 7-day Ganpati festival) without cluttering the
existing Event / Contribution / Approvals surfaces.

**Route surface**:
- `#/e/:eventId/operations` — Overview tab (default)
- `#/e/:eventId/operations/plan` — 7-day plan (Phase 3 scaffold)
- `#/e/:eventId/operations/activities` — Activities grid
- `#/e/:eventId/operations/activity/:activityId` — Activity detail
- `#/e/:eventId/operations/people` — People directory
- `#/e/:eventId/operations/matrix` — Responsibility matrix

Entry point on the event detail page: `🎯 Operations · Open
workspace` card, visible when both `operations.workspace` is enabled
for the event AND the caller has `operations.view`.

**Feature flags** (`config/features.json`, all event-scoped):
- `operations.workspace` — master toggle, default OFF.
- `operations.people`, `operations.tasks`, `operations.matrix`,
  `operations.contact_directory` — sub-features that depend on the
  master toggle so an admin can trim the workspace to what the event
  actually needs (a one-day event can hide the matrix; a 7-day
  festival enables everything).

**RBAC** (`config/roles.json`, new capabilities):
- `operations.view` — admin, secretary, mgmt, committee, manager.
- `operations.manage` — admin, secretary, mgmt, committee (delete
  activities, edit any field).
- `operations.ownership.manage` — admin, secretary, mgmt (only the
  top of the hierarchy can reshape ownership areas).
- `operations.activity.create` / `operations.activity.edit` /
  `operations.people.manage` / `operations.volunteers.assign` /
  `operations.tasks.manage` / `operations.contacts.view` —
  admin, secretary, mgmt, committee.

Assignment-level delegation: if a caller is the linked person for an
activity's primary or co-lead (matched by lower-cased email), the
`canManageActivity(activity, user, caps)` helper returns true even
when they lack `operations.manage`. This is how a committee-appointed
lead gets edit rights on their own activity without needing broader
capabilities.

**Data model** (single blob per event, persisted at
`tvh:v1:operations:<eventId>` via `state.operationsFor` /
`state.saveOperationsFor`):

```
{
  version: 1,
  updated_at, updated_by,
  categories: [ { id, label, icon } ],
  people:     [ { id, name, flat, mobile, email } ],
  ownership:  [ { id, area, description, person_id, responsibilities } ],
  activities: [ {
    id, title, category, icon,
    days:[Number], start_time, end_time, location,
    owner_id, status,
    primary_lead_id, co_lead_id,
    volunteer_ids:[], responsibilities:[], tasks:[]
  } ]
}
```

IDs are used everywhere so a person's name / flat / mobile changes
in one place and every activity reflects it. Removing a person from
the directory automatically detaches them from every ownership and
activity reference.

**Overview tab — visible components**:
- Four KPI tiles: `Event Owners` (filled/total), `Activities`,
  `Volunteers` (unique across activities), `Attention` (count).
- Operational health bars: Ready / In progress / Attention /
  Not started with monospace bar fills.
- **Needs Attention** list with clickable items — owner missing,
  primary lead missing, co-lead missing, no volunteers on an
  in-progress activity, or explicit `attention` status. Each link
  jumps to the activity detail (or ownership for owner-missing).
- Ownership grid: 4 default areas (Overall Coordination · Cultural
  Program · Operations & Logistics · Finance & Coordination),
  seeded on demand. Each card shows avatar + name + flat OR a
  "Not assigned" pill with an inline Assign owner CTA. Cards show
  the activities under each area.
- Empty-state nudge: "🎯 Let's organise this event · Start planning".

**Activities tab**: grid of activity cards, each with icon +
title + category + status pill + primary/co-lead avatars +
volunteer count. Missing bits (`⚠ Primary lead · Co-lead ·
Volunteers missing`) are surfaced inline in red. Add / edit modal
covers title, icon, category, owner area, location, days-of-event
picker, start / end time, primary + co-lead pickers (both drawn
from the People directory), status.

**Activity detail** (`.../activity/:activityId`): Leadership block
with two lead cards (mobile shown only to `operations.manage`
holders per §16), volunteer panel with add-from-directory picker,
responsibilities list, and a tasks placeholder pending Phase 3.

**People tab**: reusable directory. Each card shows avatar + name +
flat + (mobile if caller has `operations.manage`) + a compact
`current roles` list computed from ownership + activity assignments
so nobody has to enter the same information twice.

**7-Day plan tab** (Phase 3 scaffold): renders a day strip
`Day 1 … Day N` computed from `event.start_at → event.end_at`
(defaults to 7 when dates are missing), with each day showing the
activities scheduled that day. Visual timeline UI lands in Phase 3.

**Matrix tab** (Phase 4 scaffold): table with Activity · Owner ·
Primary · Co-lead · Volunteers · Status columns. Filters land in
Phase 4.

**Persistence policy alignment**:
- Ops writes go through `saveOperationsFor(eventId, doc)` which
  currently persists locally. Archive push wiring lands in Phase 5
  so `automation-policy.md`'s "Documented local-only exceptions"
  list will grow once the archive shape is finalised.

**Roadmap slots**:
- Phase 2 — People directory expansion (avatar upload, bulk import)
- Phase 3 — Multi-day timeline UI + task management
- Phase 4 — Matrix filters (Day / Category / Status / Missing lead)
- Phase 5 — Archive persistence + mobile polish + guided setup

Core implementation:
- `config/features.json` — 5 new event-scope flags under
  the `operations` cluster.
- `config/roles.json` — 8 new operations.* permission keys.
- `assets/js/store.js` — `operationsFor` / `saveOperationsFor` /
  `clearOperationsFor` on the state facade.
- `assets/js/operations.js` — data layer: CRUD for people,
  ownership, activities, plus `healthSnapshot`,
  `canManageActivity`, and `selfPersonId` helpers.
- `assets/js/views/operations.js` — the workspace shell +
  Overview + Ownership + Activities + Activity detail + People
  + 7-day scaffold + Matrix scaffold.
- `assets/js/views/event.js` — `🎯 Operations` entry card on the
  event detail page.
- `assets/js/app.js` — six new router registrations under
  `/e/:id/operations/*`.
- `assets/css/base.css` — `.tvh-ops-*` styles (tabs, KPIs, health
  bars, owner grid, activity grid, people grid, lead chip,
  avatar, day picker, attention list).
