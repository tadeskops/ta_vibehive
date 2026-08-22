# VibeHive Implemented UI/UX Requirements (Current State)

Date: 2026-08-22
Scope: Current shipped behavior in ta_vibehive.

## 1) Navigation and Information Architecture

Implemented:
- Header navigation: Home, Events; role-gated links for Reports/Settings/Admin.
- Verify receipt entry points (header nav, mobile tab, and footer action) are configuration-gated via `navigation.show_verify` and default OFF.
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

Core UI files:
- `assets/js/busy.js`
- `assets/js/app.js`
- `assets/css/base.css`

## 2) Home Dashboard UX

Implemented:
- KPI cards (events, contributors, collected amount, committee context).
- Latest contributions panel with configurable row count.
- Signed-out masking behavior uses blur-based UI treatment instead of hard hide text replacement.

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
- Event report link is shown when event-level report list view is enabled.

Core UI files:
- `assets/js/views/event.js`
- `assets/js/views/events.js`

## 4) Contribution UX

Implemented:
- Contribution form supports event payment instructions and validation helpers.
- Note field and verification details support resident update edge cases.
- Draft persistence prevents data loss on refresh.
- Manual UPI mode UI:
  - Shows configurable UPI ID and copy action.
  - Supports attached society-level UPI QR image from Settings, with event-level QR override retained.
  - Provides QR actions to view full image and save to phone from the contribute screen.
  - Resident pays in external UPI app, then submits UTR/proof.
  - Payment-mode chooser is not exposed for app-triggered auto payment capture.
- Resident-only help note copy explicitly routes issue handling to society manager / cultural committee for assisted upload and post-verification receipt sharing.

Core UI files:
- `assets/js/views/contribute.js`

## 5) Reports UX

Implemented:
- Event-specific list report route (`#/reports/event/:id`) with access controls.
- Filter controls: scope, statuses, grouping, columns.
- Event-based filter is available before export so report download can be scoped to one selected event.
- Event selector list includes live events and past events.
- Export/print/archive actions are visibility-gated by feature settings.
- UI cleanup completed: removed literal `null` artifacts during conditional section rendering.
- Export action label is explicit (`Export report (CSV)`) for discoverability.

Core UI files:
- `assets/js/views/reports.js`

## 6) Settings UX

Implemented:
- Society settings page with grouped sections (branding, payment, receipts, dashboard, event flow, privacy defaults).
- Desktop footer visibility toggles.
- Footer brand-row chips (`source` and build/version tag) are configurable and default to hidden, leaving only society brand text visible.
- Resident email governance tools:
  - Bulk gmail parser
  - TSH-style access-tier editor (add tier, rename tier, set rank, map to base role profile, assign tier emails)
  - Role-to-email mapping (one or more IDs per role)
  - Admin-only editability for admin role mappings; secretary/mgmt can edit non-admin role mappings
  - Access table visibility state
- Desktop footer legal line remains suppressed by policy; source/build chips are configurable from settings.
- Dense resident-governance grid in Settings is collapsed by default and expands on tap.

Core UI files:
- `assets/js/views/settings.js`

## 7) Admin UX

Implemented:
- Grid/table-heavy sections in Admin (roles, permission matrix, users, audit, bug reports) are collapsed by default.
- Sections expand inline without navigation, preserving existing permissions.
- Roles and permissions presentation is transposed to role-first cards for readability on narrow screens.

Core UI files:
- `assets/js/views/admin.js`
- `assets/css/base.css`

## 7) Admin UX (Archive Operations)

Implemented:
- Society settings panel in admin includes archive repo, branch, and PAT fields.
- Draft indicators for settings edits and archive outbox count.
- Flush archive queue button performs real archive push and returns actionable status feedback.

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
