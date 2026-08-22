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

Core implementation:
- `assets/js/views/reports.js`
- `assets/js/events.js`

## 5) Resident Email Governance and Role Mapping

Implemented:
- Gmail allowlist parser accepts newline/comma/semicolon/space separators.
- Role-to-email mapping supports one-or-more email IDs per role.
- Backward-compatible email-to-role index is maintained for runtime lookup.
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

Current enforced behavior:
- Desktop legal/source meta lines are intentionally suppressed from the end-user footer UI.
- Settings keeps desktop toggles for social/bug/verify actions only.

Core implementation:
- `assets/js/views/settings.js`
- `assets/js/app.js`
- `config/society.json`

## 7) Contribution Flow and Data Safety

Implemented:
- Contribution form includes note/remarks and validation helpers.
- Per-event draft cache survives refresh and is cleared on successful submit.
- One-contribution-per-flat event rule is supported and enforced at storage guard level.

Core implementation:
- `assets/js/views/contribute.js`
- `assets/js/events.js`
- `assets/js/store.js`

## 8) Receipt ID and Receipt Archive

Implemented:
- Event-based receipt ID format using time components and collision fallback.
- Verified receipt generation stores verification hash and archive metadata.
- Immediate archive push is attempted on write; outbox fallback ensures no data loss.

Core implementation:
- `assets/js/receipts.js`
- `assets/js/archive.js`
- `assets/js/archive-runtime.js`

## 9) Direct Immediate Write to tvh_record

Implemented:
- Archive pipeline supports immediate push for:
  - Receipt records
  - Event moderator history records
  - Report snapshots
- On push failure, drained entries are re-queued automatically.
- Manual retry is available via Admin → Society settings → Flush archive queue.

Required runtime settings:
- `receipts.archive_repo`
- `receipts.archive_branch` (default `main`)
- `receipts.archive_pat` (fine-grained token with repo contents read/write)

Core implementation:
- `assets/js/archive-runtime.js`
- `assets/js/views/admin.js`
- `assets/js/views/reports.js`
- `assets/js/events.js`
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

Known non-blocking browser message:
- CSP `frame-ancestors` warning when delivered via meta tag in localhost context. This does not block app flows.

## 11) Out of Scope / Not Yet Implemented Here

Not included in this implemented-state document:
- OTP backend/email-provider workflow
- Public receipt verification backend expansion beyond current local path
- Multi-language content rollout
- Other roadmap-only items listed in README roadmap
