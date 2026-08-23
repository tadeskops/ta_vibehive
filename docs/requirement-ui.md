# VibeHive Implemented UI/UX Requirements (Current State)

Date: 2026-08-22
Scope: Current shipped behavior in ta_vibehive.

## 1) Navigation and Information Architecture

Implemented:
- Header navigation: Home, Events; role-gated links for Reports/Settings/Admin.
- Verify receipt entry points (header nav, mobile tab, and footer action) are configuration-gated via `navigation.show_verify` and default OFF.
- Desktop footer verify action is intentionally suppressed; verify visibility applies to header/mobile entry points.
- Auth state controls in header: sign-in for signed-out users, sign-out for signed-in users, and whoami role chip.
- Route-driven SPA with stable hash routes for all main surfaces.
- Quick action `+` is reserved for "Create a new event" only.
- Quick action `+` visibility is role/config driven through `events.create` permission.
- Quick action stack popup is temporarily disabled (code retained); tapping `+` directly routes to the event-create surface.
- Mobile-first guardrails: sign-out remains visible on mobile; export icon remains visible in compact icon-only form.
- Mobile header layout follows a two-row right-cluster pattern (icons + auth on first row, role chip on second row).
- Auth buttons use TSH-style in/out icon semantics (right-to-bracket / right-from-bracket) with compact labels.
- Interactive elements show a subtle translucent hover/press feedback layer on desktop and touch press states.

Core UI files:
- `index.html`
- `assets/js/app.js`
- `assets/js/router.js`

## 1.1) Global Progress Signal

Implemented:
- Header border glow is now a global backend-progress indicator across all views.
- Triggered for network activity and route/view rendering transitions.
- Triggered during explicit settings save operations.

Core UI files:
- `assets/js/busy.js`
- `assets/js/app.js`
- `assets/css/base.css`

## 2) Home Dashboard UX

Implemented:
- KPI cards. Signed-in users see three tiles — `Live events`,
  `Contributors`, `Collected` — in a `.grid-4` container. The
  legacy `Committee · Cultural · Sports · Volunteers` KPI and the
  matching hero chip strip were removed (2026-08-23) because they
  were static labels rather than data.
- Latest contributions panel with configurable row count.
- Signed-out masking behavior uses blur-based UI treatment instead
  of hard hide text replacement.
- Event spotlight card renders its four KPIs (`Raised / Pending /
  Contributors / Net`) inside a `.tvh-kpi-grid` that adapts to
  container width.
- Mobile breakpoints (2026-08-23):
  - `.grid-4` mobile uses `minmax(130px, 1fr)` so KPI tiles pack
    2-per-row on a 390 px viewport instead of stacking
    1-per-row.
  - `.tvh-kpi-grid` mobile uses `minmax(110px, 1fr)` with tighter
    padding and reduced `.tvh-kpi-v` font size so the spotlight
    KPIs render as a 2×2 dashboard.
- Daily visit-counter card on mobile shows `Unique today` and
  `Total so far` side-by-side (see requirement.md §18).

Core UI files:
- `assets/js/views/home.js`
- `assets/css/base.css`

## 3) Event UX

Implemented:
- Event lifecycle view with role-aware Edit/Manage/Contribute actions.
- Event editor includes:
  - Purpose, goal, dates, capacity, payment details
  - Governance toggles (history tracking, signed-in report view, allowlist restriction)
  - Feature dependency enforcement
  - Per-event receipt theme picker (see requirement.md §15)
- Event report link is shown when event-level report list view is
  enabled.
- **Contributor board** (`renderPublicBoard`):
  - Shows When / Contributor / Flat / Amount / (Status for non-
    residents) / Receipt columns.
  - Row-level receipt actions: view (👁), WhatsApp share, download
    (⬇) — residents get their own verified receipts only;
    committee-and-above get all verified receipts.
  - Amount masking respects the layered privacy flags:
    - `privacy.amount_hidden` → em-dash for everyone.
    - `privacy.mask_amounts_resident` (new, 2026-08-23) →
      `•••` chip for residents on rows they do not own; own
      row still shows the real amount so the resident can
      reconcile with their receipt. Non-resident roles are
      unaffected. Board header adds a one-line explainer to
      residents when the flag is on.
    - Per-row `c.hide_amount` (contributor's own opt-out) →
      em-dash regardless of role.
  - Dashboard tally stats (Goal / Raised / Contributors / Time
    left) are unaffected by the resident mask so aggregate
    transparency is preserved.
- **Event admin view** (`#/e/:id/manage`, `renderManage`):
  - Header renders `Event admin · <title>` with an
    `→ All approvals` link back to the cross-event Approvals
    inbox at `#/manage`.
  - Pending contributions + Expenses + moderator/verify history
    reflow into label/value cards below 640 px (see §10 below and
    requirement.md §19).
  - Admin-only `⚠ Danger zone` card at the bottom when status is
    `closed` or `archived`, with type-the-title confirmation and
    an emerg-styled `Purge event & all records` button (see
    requirement.md §16).

Core UI files:
- `assets/js/views/event.js`
- `assets/js/views/events.js`

## 4) Contribution UX

Implemented:
- Contribution form supports event payment instructions and
  validation helpers.
- Draft persistence prevents data loss on refresh; drafts migrate
  the old `draft.method` field into the new `payment_type +
  online_kind` pair transparently (see requirement.md §7).
- **Tabbed payment type UX** (2026-08-23):
  - Two segmented tabs at the top: `💳 Online` · `💵 Cash`.
    Panels swap in place; one panel is visible at a time.
  - **Online panel** — pay via UPI or bank transfer. When both
    are enabled a sub-radio chip row (`UPI` · `Bank transfer`)
    picks the kind; otherwise the single enabled kind is
    auto-selected. Society/event UPI ID + QR (or bank details) are
    shown inline. Residents supply EITHER a `Transaction number`
    (UPI UTR / NEFT ref) OR upload a `Payment proof` (screenshot /
    PDF) — at least one is required; both cannot be blank. Rule
    text is rendered below the fields.
  - **Cash panel** — short callout explains the flow, then
    captures `Paid to (name)` (mandatory), `Paid to (mobile)`
    (mandatory, 10-digit strip / `+91` tolerant), `Paid to
    (flat)` (optional).
  - Single `Comment (optional)` textarea below both panels applies
    to whichever type is active.
  - Dropped chrome: the previous three-way `Payment method`
    dropdown, the bordered `Payment verification (any one of the
    two)` group, the `Fields marked with an asterisk` notice, and
    the trailing methods tagline.
- Manual UPI mode UI features (view/save QR, external app hand-off,
  UTR/proof submission) unchanged.
- Resident-only help copy explicitly routes issue handling to
  society manager / cultural committee for assisted upload and
  post-verification receipt sharing.
- Defensive guards (2026-08-23): `evt.tiers` coerced to array so
  events without tiers no longer crash the form.

Core UI files:
- `assets/js/views/contribute.js`
- `assets/css/base.css` — `.tvh-pt-tabs`, `.tvh-pt-tab`,
  `.tvh-pt-panel`, `.tvh-pt-subtabs`, `.tvh-pt-chip`

## 5) Reports UX

Implemented:
- Event-specific list report route (`#/reports/event/:id`) with
  access controls.
- Filter controls: scope, contribution statuses, expense inclusion +
  status filter, grouping, columns, report title.
- Event-based filter is available before export so report download
  can be scoped to one selected event.
- Event selector list includes live events and past events.
- **Include-Expenses toggle + Expense-status filter** (2026-08-23):
  - `Include expenses against these events (recommended)` checkbox,
    default **ON**. Turning it OFF removes the Expenses summary
    block and the PDF's second header line.
  - `Expense status` set (`pending` + `verified`) appears when
    include is ON. Default = **verified only**. Safeguard forces
    `verified` back on if the user unticks both.
  - Contribution status section renamed from `Status` to
    `Contribution status` for disambiguation.
  - Summary label: `Expenses in scope (N rows · <filter> · Rs.X
    verified spent · Rs.Y net)` with an inline note when pending
    rows are included but not counted in Net.
  - Category breakdown table gains a `Verified ₹` column.
  - PDF header second line mirrors the same shape so PDF and
    screen show matching numbers.
  - Empty-scope fallback message replaces silent dead-space.
- PDF download/archive actions are visibility-gated by feature
  settings and `reports.export` permission.
- UI cleanup completed: removed literal `null` artifacts during
  conditional section rendering.
- Report action labels are explicit (`Download report (PDF)` and
  `Save PDF to archive`) for discoverability.

Core UI files:
- `assets/js/views/reports.js`

## 6) Settings UX

Implemented:
- Society settings page with grouped sections (branding, payment, receipts, dashboard, event flow, privacy defaults).
- Attributes-tab changes are staged first and applied through one consolidated "Save all settings changes" action.
- Receipt templates tab uses explicit staged Save/Discard actions for batched template updates.
- Expense preferences tab uses explicit staged Save/Discard actions for batched preference updates.
- Desktop footer visibility toggles.
- Footer brand-row chips (`source` and build/version tag) are configurable and default to hidden, leaving only society brand text visible.
- Resident email governance tools:
  - Bulk gmail parser
  - Direct role-to-email mapping (one or more IDs per role) shown as vertical collapsible role cards
  - Role cards include role-specific color markers and member-count chips for quick scanning
  - Role mapping is authoritative at sign-in; emails not mapped to any explicit role default to Resident access
  - Role mapping edits are auto-included in "Save all settings changes" (manual "Stage role mapping" remains available)
  - Admin-only editability for admin role mappings; secretary/mgmt can edit non-admin role mappings
  - Access table visibility state
  - Resident access/role-email section is expanded by default for easier discoverability
- Desktop footer legal/source meta lines remain suppressed by policy.
- Dense resident-governance grid in Settings is collapsed by default and expands on tap.

Core UI files:
- `assets/js/views/settings.js`

## 7) Admin UX

Implemented:
- Grid/table-heavy sections in Admin (feature clusters, roles, permission matrix, users, audit, bug reports, admin settings panels) are collapsed by default.
- Sections expand inline without navigation, preserving existing permissions.
- Roles and permissions presentation is transposed to role-first cards for readability on narrow screens.
- Roles tab includes a direct shortcut to the Settings role-email access mapping section.

Core UI files:
- `assets/js/views/admin.js`
- `assets/css/base.css`

## 7) Admin UX (Archive Operations)

Implemented:
- Society settings panel in admin includes archive repo, branch, and PAT fields.
- Society settings panel in admin includes optional fallback archive repo so archive writes can target either configured private repo.
- Draft indicators for settings edits and archive outbox count.
- Flush archive queue button performs real archive push and returns actionable status feedback.
- Archive queue includes event snapshot writes triggered by event saves in addition to receipts/history/reports.
- Event create/edit/publish UX is repo-gated: success toast/navigation occurs only after archive push succeeds; archive failure blocks save and keeps user on editor with explicit error.
- Settings tab save buttons (attributes/templates/expense preferences) are consolidated batch saves and now repo-gated: on archive failure, local writes are rolled back and the user remains in the editor with explicit error.

Core UI files:
- `assets/js/views/admin.js`
- `assets/js/archive-runtime.js`

## 8) Accessibility and Interaction Notes

Implemented:
- Skip-to-content link and semantic sections/headings present.
- Role/action gating prevents inaccessible dead-end actions.
- Warning/feedback toasts provided for configuration and save outcomes.

Observed non-blocking note:
- `frame-ancestors` CSP warning appears in localhost console due meta-delivered CSP. No UI break observed.

## 9) UX Validation Outcome (Current)

Validated flows:
- Sign-in via localhost demo persona
- Create event from template
- Edit and publish event
- Enable event report list and open route
- Navigate settings/admin/report pages under role-gated access

Fixed during validation:
- Event report toggle now synchronizes with event feature flag so route access matches UI toggle.
- Reports page conditional rendering no longer emits stray `null` text nodes.
- Desktop footer legal/source lines are hidden on desktop per product direction.
- Header progress glow appears during route loads and backend/network activity in every view.

## 10) Approvals & Event admin — Table Reflow on Mobile (2026-08-23)

Implemented:
- `#/manage` renders as **Approvals** (cross-event inbox for pending
  contributions + pending expenses + recent approval activity).
- `#/e/:id/manage` renders as **Event admin** with an
  `→ All approvals` link back to the cross-event inbox.
- Below the 640 px breakpoint every `table.table` reflows into a
  stacked card list:
  - `thead` hides; each `tbody tr` becomes a 2-column CSS grid.
  - Every `<td>` carries a `data-label` attribute (stamped
    automatically at mount time by
    `applyResponsiveTableLabels()` in `assets/js/dom.js`) and
    renders that label as an uppercase caption above the value.
  - Compound cells (`Contributor / Event`, `Category / Event`,
    `Description`, `Ref / proof`, `Actions`, `Note / detail`,
    `Subject`, `Note`) span the full row.
  - Buttons inside the `Actions` cell wrap with `gap: 6px`
    instead of shrinking; empty-state colspan rows centre their
    text.
- Desktop (≥ 641 px) layout is unchanged; the tabular presentation
  is preserved above the breakpoint.
- Access gates unchanged: residents on `#/manage` get a
  `Not authorised` card; non-admin roles never see the danger-zone
  card on `#/e/:id/manage`.

Core UI files:
- `assets/js/dom.js` — `mount()` + `applyResponsiveTableLabels()`
- `assets/js/views/manage.js`
- `assets/js/views/event.js`
- `assets/css/base.css` — `@media (max-width: 640px)` reflow

## 11) Danger-Zone Purge on Event admin (2026-08-23)

Implemented:
- Admin-only red card at the bottom of `#/e/:id/manage`, visible
  only when the event's status is `closed` or `archived`.
- Card wording states exactly what will be deleted: contributions,
  expenses, history entries, matching audit rows.
- Confirmation input requires typing the event title verbatim; the
  `Purge event & all records` emerg-styled button unlocks only on
  match.
- On success the app toasts the counts and navigates to
  `#/events`.
- All non-admin roles never see this UI regardless of status.

Core UI files:
- `assets/js/views/event.js` — `renderDangerZone()`
- `assets/css/base.css` — `.tvh-danger-zone`, `.btn-emerg[disabled]`

## 12) Session-Level Mobile Hardening Rollup (2026-08-23)

Small polish shipped alongside larger UX changes:
- Long path / URL previews (`<code class="sub">`) wrap via
  `word-break: break-all; overflow-wrap: anywhere` so the Settings
  and Reports views no longer blow past a 390 px viewport.
- Contribute view guards `evt.tiers` with `Array.isArray()` so an
  event missing the field never crashes the form.
- Floating rotating progress ring (top-right) surfaces `busy.on()`
  label whenever a network / archive operation is in flight.
- About Samana Sippa Labs modal documents the six core pillars,
  principle, and how VibeHive lives them.
- `_dev/` is gitignored — the local dev sign-in harness at
  `ta_vibehive/_dev/signin.html` bypasses Google OAuth for local
  role-switching but is never deployed.
