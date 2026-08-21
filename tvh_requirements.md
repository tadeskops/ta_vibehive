# tvh_requirements.md — Functional Requirement Architecture

**Project:** ta_vibehive (TVH) — Society Event & Contribution Platform
**Society scale:** ~220 flats, cooperative housing society
**Status:** LIVE — tracked at repo root; updated after every slice per `/memories/repo/ta_vibehive.md §Requirements-first workflow`.
**Last updated:** 2026-08-22 (G0-05 shipped, G1-01 shipped)
**Author role:** Senior team (PRA, BA, Society Domain Expert, Crowdfunding/Event Researcher, Financial Workflow Analyst, Mobile Strategist, Architect, Privacy Analyst, OSS Sustainability Analyst)

> Companion file: `tvh_requirements_ui.md` (UI/UX — read only after this file is approved).

> **Reading order rule (from `AGENTS.md`):** Every prompt MUST re-read this file first, align changes to a requirement, then update it after implementation.

---

## Part 0 — Implementation Status (live)

This section tracks which requirements have shipped. It is **prepended before Part A intentionally** so every prompt sees current reality before design intent. Update on every slice.

### 0.1 Stack decision (LOCKED 2026-08-21)

- **Path G-1 · Pure GitHub.** Hosting = GitHub Pages (`tadeskops/ta_vibehive`). Server-side = GitHub Actions only. Data = private repo `ta_vibehive_data` (JSON per entity + YAML config). Receipts = private repo `ta_receipts_2026`. Runtime cost = ₹0/mo. Public launch target = before 2026-09-14.
- Rationale in `temp/tvh_plan.md §0.6`. All prior deferred decisions D1–D7 resolved 2026-08-21.

### 0.2 Slice progress (Phase G-0 · Foundation — complete)

| Slice | Ships | Covers requirements | Commit |
|---|---|---|---|
| G0-01 | HTML skeleton + CSP + XCTO + Referrer-Policy + Permissions-Policy + robots + 404 + G3/G4 harness | R-SEC01 (CSP), R-SEC02 (headers), R-PERF01 (first-paint budget) | `6e3baed` |
| G0-02 | Base layout, Alpine 3.14.1 vendored (SRI), language nav stub (EN/मराठी/हिन्दी), theme picker stub, RBAC grid (`ANON` / `RESIDENT` / `COMMITTEE`), 20 rbac tests | F-ID04 (role model — 2-role launch subset), F-UX01 (language switch), R-SEC03 (SRI vendored deps) | `54556ea` |
| G0-03 | Audit-log-lite chain (SHA-256, tamper-evident, deterministic canonicalize), 14 audit tests | F-AU01 (append-only log), F-AU02 (tamper detection), R-SEC08 (audit integrity) | `24eaae2` |
| G0-04 | Client-side identity capture (name + flat + anonymous), `currentRole()` resolver, hourly rate-limiter, committee-token slot, 15 identity + 8 ratelimit tests | F-ID01 (identity), F-ID02 (flat), F-ID03 (anonymous flag), F-SEC-RL01 (client-side rate limit) | `cd0e43b` |
| G0-05 | OWASP Top-10 baseline: strict CSP + banned DOM sinks + no inline JS + SRI enforcement + secret heuristics + 15 owasp assertions; CI + local check-sec mirror | R-SEC04 → R-SEC13 (OWASP mapped) | `a0ac9cc` |

**Phase G-0 gate totals:** 72/72 tests pass · LOC 686/2500 · first-paint 19.99 KB/150 KB gz · CSS 2.37 KB/10 KB gz · runtime deps 0/30.

### 0.3 Slice progress (Phase G-1 · Contribution flow — starting)

| Slice | Status | Ships | Covers requirements |
|---|---|---|---|
| G1-01 | ✅ shipped | Ganpati event page rendered from `config/ganpati_2026.json` at route `g/ganpati-2026/`; strict schema validator + INR (Indian grouping) + date formatters + cluster tint tokens; 18 event tests | F-EV01 (event definition), F-EV03 (goal), F-EV04 (dates), F-EV09 (hero) |
| G1-02 | not started | Contribute page: tier picker + custom amount + anonymous toggle | F-CO01, F-CO03, F-CO07, F-CO12 |
| G1-03 | not started | UPI deep-link + QR + UTR capture + waiting state | F-PY01, F-PY02 |
| G1-04 | not started | Committee verify screen + GitHub App device flow auth | F-PY03, F-PY10 (lite), F-ID05 (committee auth) |
| G1-05 | not started | Confirmation email via Action + receipt-number allocation | F-NT03, F-RC01 (receipt id) |

### 0.4 Deferred to post-launch (per Priority Zero — do NOT re-open before 2026-09-14)

- MR/HI translations beyond nav labels · PDF receipts (only receipt-number at launch) · full 5-level RBAC (2 at launch) · volunteer proposals · on-behalf contributions · feature-registry UI · archive UI · 2FA · non-Ganpati event clusters · admin dashboards beyond verify queue.

### 0.5 Deviations from original design (log-once)

- **G0-04 pivot 2026-08-22:** Original plan §1.4 row said "Email OTP + session cookies". Static Pages cannot host OTP. Revised to client-side identity capture + client-side rate-limit; real committee auth ships as GitHub App device flow in G1-04.
- **G1-01 config format 2026-08-22:** Original plan §1.4 row said YAML. Switched to JSON to avoid shipping a YAML parser (saves LOC + shrinks attack surface + browser-native). YAML remains available for human-authored config in the data repo — the app just reads JSON.

---

## Part A — Problem Understanding

### A.1 The core problem
A 220-flat cooperative housing society repeatedly runs many different kinds of activities that involve money collection, registration, or coordination — festivals, sports, picnics, infra projects, emergency funds, charity drives. Today each event is run through ad-hoc WhatsApp groups, paper lists, personal UPI transfers, and Google Forms. This causes:

- Lost records year-over-year (nobody knows what was collected last Diwali).
- Zero standardization of receipts → audit and IT-compliance risk.
- Committee turnover wipes institutional memory.
- Residents lack a single trusted place to see "what's happening, what's collected, where did the money go".
- Anonymous donations vs public acknowledgement is handled by feel, not policy.

### A.2 The wrong solution (explicitly rejected)
Building "a Ganesh Chaturthi app" or "a picnic app" — anything hard-coded to one event type. Every year the requirements change and the app becomes obsolete.

### A.3 The right solution
> **One reusable platform → many configurable event types → each event activates only the features it needs.**

The system is an **event engine + contribution engine + feature registry**, not a screen collection. Committee members configure; residents experience only what's enabled for the current event.

### A.4 Success criteria
- Same codebase powers Ganesh Chaturthi 2027, sports day 2028, emergency roof-leak collection 2029, no code changes.
- Historical records for every past event remain intact, viewable, exportable — even if features are later disabled.
- A new committee in year 5 can operate the system without contacting the original developer.
- Zero mandatory paid SaaS. All recurring costs justifiable to the AGM.

---

## Part B — Global Feature Research (findings + rejections)

### B.1 Patterns adopted
| Source pattern | Origin | Why adopted |
|---|---|---|
| **Suggested-amount tiers + custom amount** | Ketto, Milaap, GoFundMe | Anchors giving without forcing; residents contribute what they're comfortable with. |
| **Progress bar with goal + contributor count (not names)** | Kickstarter, Milaap | Creates transparency and social proof without violating privacy. |
| **Anonymous vs disclosed toggle per contribution** | GoFundMe, Ketto | Some donors want recognition, some do not. Society policy also varies by event. |
| **Event templates + one-click duplicate previous year** | Eventbrite, Luma | Committee turnover means each new organizer should start from a proven template, not a blank form. |
| **Flat-based identity (not just email)** | MyGate, ADDA, NoBrokerHood | Society membership is the source of truth; email is only a login channel. |
| **Owner + tenant + family member sub-identities under one flat** | ADDA, NoBrokerHood | Reflects real occupancy; tenant may contribute to Diwali but not vote on infra. |
| **Publish → registration/contribution active → closed → archived lifecycle** | Meetup, Eventbrite | Prevents editing an event mid-collection without an audit trail. |
| **Receipt with unique ID + regeneration + revision history** | Standard cooperative accounting | Society audit and IT-return requirement. |
| **Configurable expense-summary publication** | Charity Navigator, GiveIndia | Transparency post-event, but committee decides what's public. |
| **Idempotent payment webhooks with reconciliation queue** | Razorpay, Stripe | Handles duplicate webhooks, timeouts, and partial failures. |
| **Feature flags / feature registry (LaunchDarkly pattern, minimal)** | LaunchDarkly, Unleash | Enable/disable modules per event without redeploy. |
| **Data export as portable ZIP (JSON + PDFs)** | GDPR data-portability apps | Society retains ownership; no vendor lock-in. |
| **Passwordless email OTP / magic link** | Notion, Slack, Substack | Removes password reset support burden; safer for a 220-person user base with mixed digital literacy. |
| **Read-only auditor role** | HOA & cooperative apps | Society appoints an internal auditor annually. |

### B.2 Patterns **rejected** (would create unnecessary complexity)
| Rejected pattern | Reason |
|---|---|
| Full form builder (drag-and-drop, custom field types, conditional logic) | Turns product into a low-code platform. Master prompt §15 explicitly warns against this. Use a bounded catalogue of fields + admin toggle instead. |
| Marketplace / vendor listings (grocers, plumbers, packers) | Not the problem this platform solves. Belongs to MyGate/NoBroker. Adding it explodes scope. |
| Visitor/gate-pass management | Same as above; distinct platform (`ta-society-helpdesk` already handles helpdesk-side). |
| Chat / messaging inside the app | WhatsApp already wins here. Duplicating it just fragments communication. |
| Loyalty points / gamified donation badges | Culturally inappropriate for a residential society; monetary contribution shouldn't be gamified. |
| In-app wallet / stored balance | Regulatory (RBI PPI) burden; society is not a licensed payment aggregator. Route every payment out to the bank/UPI directly. |
| Native mobile app (day 1) | PWA covers 95% of needs at a fraction of maintenance cost. Native is Phase 3, only if genuinely justified. |
| Push notifications (day 1) | Requires FCM / paid providers + user permission churn. Email + WhatsApp deep-links cover the same jobs sustainably. |
| Blockchain / crypto donations | Not aligned with a housing-society AGM audience or Indian regulatory reality. |
| AI chatbot | Adds recurring API cost, adds hallucination risk to financial context. Not needed. |

### B.3 Neutral / deferred patterns
- **Public leaderboard of top contributors** — culturally sensitive; leave configurable, default OFF.
- **Recurring auto-debit (mandates / eNACH)** — real need for monthly maintenance, but that's a *maintenance* problem, not an event problem. Defer to Phase 3.
- **Multi-society tenancy** — one society for now; keep DB schema tenant-aware but don't build the switcher.

---

## Part C — Complete Event Taxonomy

Seven clusters. Each event **must** belong to exactly one cluster; the cluster preselects a template (see Part K.4).

### Cluster A — Festival & Celebration Events
Ganesh Chaturthi, Diwali, Holi, Navratri, Christmas, New Year, Independence Day, Republic Day, Society Anniversary, Cultural nights.
**Typical needs:** voluntary contribution, suggested tiers, anonymous/disclosed choice, volunteer signup, event schedule, expense summary at end.

### Cluster B — Social & Community Events
Society picnic, community dinner, cultural evening, children's program, senior citizens' meet.
**Typical needs:** registration (with head-count), adult/child split, food preference, participation fee, capacity cap, waiting list.

### Cluster C — Sports & Competition Events
Cricket, badminton, football, indoor games, kids' races, chess.
**Typical needs:** individual OR team registration, age category, participant details (age, contact), registration fee, max slots, waiting list, brackets/schedule (view-only).

### Cluster D — Voluntary Donation & Fundraising
Charity drive, community welfare, targeted-cause fundraising.
**Typical needs:** suggested + custom amount, anonymous option, goal tracking, public progress %, contributor count (not names by default), campaign updates.

### Cluster E — Emergency / Urgent Collections
Roof leak, disaster support, medical emergency (society-approved), urgent security repair.
**Typical needs:** high-visibility banner, short deadline, minimal registration friction, one-click contribute, immediate updates.

### Cluster F — Infrastructure & Improvement Projects
Solar panels, garden redevelopment, security upgrade, water conservation, gym equipment.
**Typical needs:** project description, funding target, milestones (phase-1/phase-2), phased collection, progress updates, expense transparency, before/after summary.

### Cluster G — Non-Financial Events
AGM, workshop, awareness program, volunteer callout, blood-donation drive.
**Typical needs:** event info + optional RSVP + optional volunteer signup — but **no payment engine activated**.

**Design implication:** the same event engine powers all seven clusters. Cluster G proves the engine is truly decoupled from payment.

---

## Part D — Requirement Clusters (final structure)

Improved from master-prompt §27:

1. **Identity & Authentication** (§D.1)
2. **Society & Flat Registry** (§D.2)
3. **Event Engine** — templates, lifecycle, configuration (§D.3)
4. **Contribution Engine** — models, privacy, tiers (§D.4)
5. **Participation Engine** — registration, capacity, waiting list (§D.5)
6. **Payment & Reconciliation** (§D.6)
7. **Receipts** — generation, revision, delivery (§D.7)
8. **Receipt Archive** — separate subsystem (§D.8)
9. **Transparency & Reporting** (§D.9)
10. **Notifications** (§D.10)
11. **Administration** — normal + advanced (§D.11)
12. **Feature Registry & Configuration Safety** (§D.12)
13. **Historical Snapshots & Config Versioning** (§D.13)
14. **Sustainability, Backup, Migration** (§D.14)
15. **Security, Privacy, Compliance** (§D.15)

Each cluster is expanded in Part E (feature catalogue) and mapped in Parts F/G/H.

---

## Part E — Master Feature Catalogue

Codes: `F-<cluster><nn>`. Status: **MVP** / **P2** / **P3** / **AVOID**.

### E.1 — Identity & Authentication
| ID | Feature | Description | Status |
|---|---|---|---|
| F-ID01 | Email OTP login | 6-digit code to registered email, no password. | MVP |
| F-ID02 | Magic link login | One-tap link as alternative to OTP. | MVP |
| F-ID03 | Google OAuth | Optional convenience login. | P2 |
| F-ID04 | Session management | Remembered device + explicit logout + auto-expiry. | MVP |
| F-ID05 | Resident verification | Committee approves new signup by flat number before full access. | MVP |
| F-ID06 | Sub-identities per flat | Owner, tenant, family members — distinct logins under one flat. | MVP |
| F-ID07 | Role assignment | Resident / Admin / Financial Admin / Auditor / Advanced Admin. | MVP |
| F-ID08 | Password login | Explicitly not supported. Rationale in §B.1. | AVOID |
| F-ID09 | Phone/SMS OTP | Depends on paid SMS gateway. | P3 |

### E.2 — Society & Flat Registry
| ID | Feature | Description | Status |
|---|---|---|---|
| F-SO01 | Society profile | Name, registration number, address, PAN, official contact — used on every receipt. | MVP |
| F-SO02 | Flat directory | Wing/tower + flat number + occupancy status. | MVP |
| F-SO03 | Occupancy linking | Owner ↔ flat, tenant ↔ flat with tenancy start/end. | MVP |
| F-SO04 | Multi-society | Schema-ready; UI not built. | P3 |

### E.3 — Event Engine
| ID | Feature | Description | Status |
|---|---|---|---|
| F-EV01 | Event templates | Pre-configured feature sets per cluster (A–G). | MVP |
| F-EV02 | Duplicate previous event | One-click clone of last year's event, all config preserved. | MVP |
| F-EV03 | Event draft state | Save without publishing. | MVP |
| F-EV04 | Publish workflow | Draft → review → published; irreversible flag once contributions start. | MVP |
| F-EV05 | Scheduled publish | Auto-publish at chosen datetime. | P2 |
| F-EV06 | Pause/resume | Freeze contributions temporarily without closing. | P2 |
| F-EV07 | Close event | Stops new contributions/registrations; records remain viewable. | MVP |
| F-EV08 | Archive event | Removes from active lists; still accessible via history. | MVP |
| F-EV09 | Event image / hero | Cover image with sensible defaults per cluster. | MVP |
| F-EV10 | Event updates / posts | Committee posts progress updates visible on event page. | MVP |
| F-EV11 | Multi-phase milestones | For infra projects — phase 1 goal, phase 2 goal. | P2 |
| F-EV12 | Recurring event series | E.g., yearly Diwali. Linked history across years. | P2 |

### E.4 — Contribution Engine
| ID | Feature | Description | Status |
|---|---|---|---|
| F-CO01 | Voluntary contribution | Any amount ≥ minimum. | MVP |
| F-CO02 | Fixed contribution | Same amount for every flat. | MVP |
| F-CO03 | Suggested tiers | 3–5 preset amounts + custom option. | MVP |
| F-CO04 | Per-flat model | One contribution per flat counted. | MVP |
| F-CO05 | Per-person model | Contribution scales with head count. | P2 |
| F-CO06 | Multiple contributions | Same resident can contribute again in same event. | MVP |
| F-CO07 | Minimum amount enforcement | Configurable per event. | MVP |
| F-CO08 | Maximum amount cap | Optional; useful for equal-contribution events. | P2 |
| F-CO09 | Contribution goal | Target amount; drives progress bar. | MVP |
| F-CO10 | Progress bar | Public % of goal + contributor count. | MVP |
| F-CO11 | Public contributor list | Names + amounts. Default OFF; committee opts in. | P2 |
| F-CO12 | Anonymous contribution | Public identity hidden; internal records intact. | MVP |
| F-CO13 | Split disclosure | Show name but hide amount, or vice versa. | P2 |
| F-CO14 | Contribution message | Optional note from contributor ("in memory of…"). | P2 |

### E.5 — Participation Engine
| ID | Feature | Description | Status |
|---|---|---|---|
| F-PA01 | Registration required flag | Event-level toggle. | MVP |
| F-PA02 | Individual registration | Single person signup. | MVP |
| F-PA03 | Family registration | Head count (adults + children). | MVP |
| F-PA04 | Team registration | For sports events. | P2 |
| F-PA05 | Age category | For sports and kids' events. | P2 |
| F-PA06 | Food preference | Veg / non-veg / jain / no-onion-garlic. | MVP |
| F-PA07 | Capacity cap | Hard limit on total slots. | MVP |
| F-PA08 | Waiting list | Auto-promote when a slot frees. | P2 |
| F-PA09 | Volunteer signup | Separate track from paid registration. | MVP |
| F-PA10 | Volunteer roles catalogue | Predefined roles: setup, cleanup, coordination. | P2 |
| F-PA11 | Registration fee | Registration triggers payment flow. | MVP |
| F-PA12 | Free registration | Head count only, no payment. | MVP |

### E.6 — Payment & Reconciliation
| ID | Feature | Description | Status |
|---|---|---|---|
| F-PY01 | UPI (deep link) | `upi://pay?...` link + QR image. | MVP |
| F-PY02 | UPI reference capture | Contributor enters UTR / txn ID after paying. | MVP |
| F-PY03 | Manual verification | Financial admin marks paid after bank check. | MVP |
| F-PY04 | Payment gateway (Razorpay/Cashfree) | Auto-verify via webhook. | P2 |
| F-PY05 | Cash / cheque record | Admin logs offline contributions. | MVP |
| F-PY06 | Bank transfer instructions | Show bank details for NEFT. | MVP |
| F-PY07 | Idempotent webhook handling | Duplicate webhooks don't double-count. | P2 |
| F-PY08 | Partial payment | Contribute in installments toward a target. | P3 |
| F-PY09 | Refund workflow | Admin-initiated; audit-logged. | P3 |
| F-PY10 | Reconciliation dashboard | Pending / verified / failed / mismatched. | MVP |

### E.7 — Receipts
| ID | Feature | Description | Status |
|---|---|---|---|
| F-RC01 | Unique receipt number | Format: `<SOCIETY>-<YEAR>-<EVENT>-<SEQ>`. Never reused. | MVP |
| F-RC02 | PDF receipt | A5 landscape; society branding; matches supplied sample. | MVP |
| F-RC03 | Auto-generate on verified payment | Immediate after F-PY03 or F-PY07 success. | MVP |
| F-RC04 | Regeneration | Same receipt number; new PDF if template updated. | MVP |
| F-RC05 | Revision history | Every regeneration logged with reason. | MVP |
| F-RC06 | Correction record | Voided receipts marked, not deleted. | MVP |
| F-RC07 | Email delivery | Attach PDF + inline HTML summary. | MVP |
| F-RC08 | WhatsApp share link | Deep link to receipt PDF. | P2 |
| F-RC09 | Anonymous receipt | Contributor sees name; public archive shows "Anonymous". | MVP |
| F-RC10 | Bulk export (CSV + PDFs zipped) | End-of-event admin export. | MVP |
| F-RC11 | Receipt template per event type | Different layout for donation vs registration. | P2 |
| F-RC12 | Digital signature / stamp | Society seal image on PDF. | MVP |

### E.8 — Receipt Archive (separate subsystem)
| ID | Feature | Description | Status |
|---|---|---|---|
| F-AR01 | Separate archive store | NOT in main app repo. | MVP |
| F-AR02 | Year → event → PDF folder structure | Predictable, human-navigable. | MVP |
| F-AR03 | Receipt index (JSON) | Machine-readable catalogue per year. | MVP |
| F-AR04 | SHA-256 integrity hash per file | Detect tampering. | MVP |
| F-AR05 | Annual archive package | ZIP for AGM sharing. | MVP |
| F-AR06 | Encrypted archive option | AES-256 for private git repo. | P2 |
| F-AR07 | Object storage backend | S3-compatible (Backblaze B2, Cloudflare R2, MinIO self-hosted). | P2 |
| F-AR08 | Retention policy | Never auto-delete; explicit purge only. | MVP |

**Recommended archive mechanism (see §K.5):** Private Git repo with PDFs + JSON index + hash file for MVP; migrate to S3-compatible object storage if volume warrants (>5 GB or >5 years).

### E.9 — Transparency & Reporting
| ID | Feature | Description | Status |
|---|---|---|---|
| F-RP01 | Resident: my contributions | Personal history across all events. | MVP |
| F-RP02 | Resident: my receipts | Download PDFs. | MVP |
| F-RP03 | Public: total collected | Configurable per event. | MVP |
| F-RP04 | Public: contributor count | Configurable per event. | MVP |
| F-RP05 | Public: expense summary | Committee publishes after event. | MVP |
| F-RP06 | Admin: reconciliation dashboard | See F-PY10. | MVP |
| F-RP07 | Admin: registration roster | List of registered participants. | MVP |
| F-RP08 | Auditor: read-only financial view | Full amounts, no edit. | MVP |
| F-RP09 | Cross-event annual report | Year-summary across all events. | P2 |
| F-RP10 | Exportable CSV | Contributions and registrations. | MVP |

### E.10 — Notifications
| ID | Feature | Description | Status |
|---|---|---|---|
| F-NT01 | Email: new event published | To all residents. | MVP |
| F-NT02 | Email: contribution reminder | Configurable N-days-before-deadline. | MVP |
| F-NT03 | Email: payment success + receipt | Immediate. | MVP |
| F-NT04 | Email: payment pending verification | To contributor + admin. | MVP |
| F-NT05 | Email: event closing soon | 24h before deadline. | MVP |
| F-NT06 | Email: event update posted | Digest. | P2 |
| F-NT07 | WhatsApp deep link | Share event / receipt via `wa.me` link. | MVP |
| F-NT08 | Browser push | Web Push API, opt-in. | P2 |
| F-NT09 | SMS | Paid gateway. | P3 |
| F-NT10 | User notification preferences | Per-event category opt-out. | P2 |

### E.11 — Administration
| ID | Feature | Description | Status |
|---|---|---|---|
| F-AD01 | Society Admin dashboard | Event CRUD, resident management, publish. | MVP |
| F-AD02 | Financial Admin dashboard | Payment verification, reconciliation. | MVP |
| F-AD03 | Auditor dashboard | Read-only reports. | MVP |
| F-AD04 | Advanced Admin dashboard | Feature registry, templates, receipt templates. | MVP |
| F-AD05 | Resident approval queue | New signup approval. | MVP |
| F-AD06 | Role assignment UI | Grant/revoke admin roles. | MVP |
| F-AD07 | Audit log viewer | All config changes, all payment verifications. | MVP |
| F-AD08 | Bulk import residents | CSV upload for society onboarding. | MVP |
| F-AD09 | Announcement banner | System-wide message. | P2 |

### E.12 — Feature Registry & Configuration Safety
| ID | Feature | Description | Status |
|---|---|---|---|
| F-FR01 | Feature registry storage | Central catalogue (see Part §L). | MVP |
| F-FR02 | System-level toggles | Global on/off. | MVP |
| F-FR03 | Event-type-level toggles | Template defaults. | MVP |
| F-FR04 | Event-level toggles | Override on individual event. | MVP |
| F-FR05 | Dependency validation | Block invalid combos (see Part G). | MVP |
| F-FR06 | Configuration lock post-publish | Payment-critical fields freeze once first contribution lands. | MVP |
| F-FR07 | Configuration change audit | Every toggle logged with actor + timestamp. | MVP |
| F-FR08 | "What-if" preview | Show what residents will see before publishing config change. | P2 |

### E.13 — Historical Snapshots & Config Versioning
| ID | Feature | Description | Status |
|---|---|---|---|
| F-HS01 | Event config snapshot | Full config JSON stored with the event record. | MVP |
| F-HS02 | Template versioning | Templates immutable once used; new version on edit. | MVP |
| F-HS03 | Historical view | Past events render exactly as they existed. | MVP |
| F-HS04 | Config diff between versions | Advanced admin tool. | P2 |

### E.14 — Sustainability, Backup, Migration
| ID | Feature | Description | Status |
|---|---|---|---|
| F-SU01 | Full data export ZIP | JSON + PDFs + config + audit log. | MVP |
| F-SU02 | Scheduled auto-backup | Daily snapshot to secondary location. | MVP |
| F-SU03 | One-click restore from backup | Advanced admin. | P2 |
| F-SU04 | Documentation bundle | README + runbook + AGM handover doc. | MVP |
| F-SU05 | Portable data format | Standard JSON schema, no proprietary encoding. | MVP |
| F-SU06 | Payment provider abstraction | Swap Razorpay ↔ Cashfree ↔ manual without code changes. | MVP |
| F-SU07 | Auth provider abstraction | Swap OTP provider without code changes. | P2 |

### E.15 — Security, Privacy, Compliance
| ID | Feature | Description | Status |
|---|---|---|---|
| F-SC01 | HTTPS everywhere | Enforced. | MVP |
| F-SC02 | PII field-level classification | Every field tagged PII/non-PII (see Part J). | MVP |
| F-SC03 | Data-subject deletion request | On resident exit, PII erased; financial records retained with pseudonymized handle. | MVP |
| F-SC04 | Rate limiting | Login + payment endpoints. | MVP |
| F-SC05 | CSRF + secure cookies | Standard hardening. | MVP |
| F-SC06 | Content Security Policy | Strict CSP. | MVP |
| F-SC07 | Encrypted at rest | DB-level encryption. | P2 |
| F-SC08 | 2FA for admin roles | TOTP app. | P2 |
| F-SC09 | DPDP Act (India) alignment | Consent, purpose limitation, retention. | MVP |

---

## Part F — Event-to-Feature Matrix

Legend: ● = required, ○ = commonly enabled, · = rarely enabled, — = not applicable

| Feature | A Festival | B Social | C Sports | D Donation | E Emergency | F Infra | G Non-Financial |
|---|---|---|---|---|---|---|---|
| Contribution (F-CO01/02/03) | ● | · | · | ● | ● | ● | — |
| Anonymous option (F-CO12) | ○ | · | · | ● | ○ | · | — |
| Suggested tiers (F-CO03) | ● | · | · | ● | ● | ● | — |
| Progress bar (F-CO10) | ○ | · | · | ● | ● | ● | — |
| Public contributor list (F-CO11) | · | · | · | · | · | · | — |
| Registration (F-PA01) | · | ● | ● | · | · | · | ○ |
| Family head count (F-PA03) | · | ● | · | · | · | · | · |
| Food preference (F-PA06) | · | ● | · | · | · | · | · |
| Team registration (F-PA04) | — | · | ● | — | — | — | — |
| Age category (F-PA05) | · | · | ● | · | · | · | · |
| Capacity cap (F-PA07) | · | ● | ● | · | · | · | · |
| Waiting list (F-PA08) | · | ○ | ○ | · | · | · | · |
| Volunteer signup (F-PA09) | ● | ○ | ○ | · | ● | ○ | ○ |
| Registration fee (F-PA11) | · | ● | ● | · | · | · | · |
| Payment (any of F-PY**) | ● | ● | ● | ● | ● | ● | — |
| Receipt generation (F-RC**) | ● | ● | ● | ● | ● | ● | — |
| Milestones (F-EV11) | · | · | · | · | · | ● | · |
| Multi-phase collection | · | · | · | · | · | ● | · |
| Urgency banner | · | · | · | · | ● | · | · |
| Event updates (F-EV10) | ○ | · | · | ● | ● | ● | · |
| Expense summary (F-RP05) | ● | ○ | ○ | ● | ● | ● | — |

---

## Part G — Feature Dependency Matrix

| Feature | Requires | Conflicts with | Optional dependencies |
|---|---|---|---|
| F-CO10 Progress bar | F-CO09 Goal | — | F-RP03, F-RP04 |
| F-CO11 Public list | F-CO12 (must resolve anonymity) | — | — |
| F-CO12 Anonymous | — | — | Split disclosure F-CO13 |
| F-PA04 Team reg | F-PA01 Registration required | F-PA03 Family | F-PA05 Age category |
| F-PA07 Capacity cap | F-PA01 Registration required | — | F-PA08 Waiting list |
| F-PA08 Waiting list | F-PA07 Capacity cap | — | — |
| F-PA11 Registration fee | F-PA01 + any F-PY** | Free reg F-PA12 | F-RC** |
| F-PY04 Gateway | F-PY07 Idempotent webhook | — | F-RC03 auto-receipt |
| F-RC03 Auto-receipt | Any F-PY** verified | — | F-NT03 email |
| F-RC04 Regeneration | F-RC01 Unique number | — | F-RC05 Revision log |
| F-EV11 Milestones | F-CO09 Goal | — | F-EV10 Updates |
| F-FR06 Config lock | First contribution recorded | — | — |
| F-HS01 Snapshot | F-FR01 Registry | — | — |
| F-SU06 Payment abstraction | Any F-PY** | — | — |

**Dependency validation rules (F-FR05):**
1. Cannot enable `Public contributor list` unless anonymity policy is defined.
2. Cannot enable `Waiting list` without `Capacity cap`.
3. Cannot enable `Registration fee` without `Registration required` AND at least one payment method.
4. Cannot enable `Progress bar` without a `Goal`.
5. Cannot disable `Receipt generation` once any receipt has been issued (existing receipts survive, but toggle locks OFF-disable).
6. Cannot change contribution model (fixed ↔ voluntary) after first contribution.
7. Cannot change receipt number format after first receipt.

---

## Part H — Configuration Scope Matrix

| Feature | System | Event Type | Event | User-visible | Admin-only |
|---|---|---|---|---|---|
| F-ID01–04 Auth methods | ✓ | · | · | ✓ | · |
| F-ID05 Approval flow | ✓ | · | · | · | ✓ |
| F-EV01 Templates | ✓ | ✓ | · | · | ✓ (Advanced) |
| F-CO01–08 Contribution model | · | ✓ | ✓ | ✓ | · |
| F-CO09 Goal | · | · | ✓ | ✓ | · |
| F-CO11 Public list | ✓ | ✓ | ✓ | ✓ | · |
| F-CO12 Anonymous option | ✓ | ✓ | ✓ | ✓ | · |
| F-PA01–10 Registration fields | · | ✓ | ✓ | ✓ | · |
| F-PY01–06 Payment methods | ✓ | ✓ | ✓ | ✓ | · |
| F-RC01 Receipt number format | ✓ | · | · | · | ✓ (Advanced) |
| F-RC02 Receipt template | ✓ | ✓ | · | ✓ | ✓ |
| F-AR** Archive settings | ✓ | · | · | · | ✓ (Advanced) |
| F-NT01–07 Notifications | ✓ | ✓ | ✓ | ✓ | · |
| F-RP03–05 Public transparency | · | ✓ | ✓ | ✓ | · |
| F-FR** Feature registry | ✓ | · | · | · | ✓ (Advanced) |

---

## Part I — Role & Permission Requirements

Five roles. Each justified.

### I.1 Resident (default)
Every verified society member. Can:
- View events (only enabled ones)
- Contribute / register / volunteer
- Download own receipts
- See public transparency reports
- Update own profile

### I.2 Society Administrator
Committee members responsible for event operations. Can everything a Resident can, PLUS:
- Create/edit/publish/close/archive events
- Approve new resident signups
- Post event updates
- View reconciliation dashboard (view only, not verify)
- View registration roster
- Publish expense summary
- Send announcements

### I.3 Financial Administrator
Treasurer / accounts-in-charge. Superset of Resident, distinct from Society Admin. Can:
- Verify manual payments
- Handle reconciliation exceptions
- Log cash/cheque contributions
- Initiate refunds (P3)
- Regenerate receipts with reason
- Export financial reports

**Justification for separate role:** Payment verification must not be done by the same person who creates/edits the event (separation of duties for audit).

### I.4 Auditor
Society's internal auditor or external CA. Read-only, superset of Resident data-wise. Can:
- View all contributions with full amounts and names
- View all receipts
- View audit log
- Export financial reports
- **Cannot** edit anything

### I.5 Advanced Administrator (a.k.a. System Custodian)
Technical custodian; typically the developer or a technically inclined committee member. Can:
- Manage feature registry
- Create/edit event templates
- Edit receipt templates
- Manage system-level toggles
- Manage payment provider connection
- Trigger backups / exports
- **Cannot** verify payments (separation from Financial Admin)

**Role assignment rule:** A single person MAY hold multiple roles, but the audit log records actions under the role that authorized them.

**Rejected roles (justification):**
- "Event moderator" — same as Society Admin, no new capability.
- "Read-only resident" — every resident is already the same read scope for public data.
- "Guest" — no anonymous guest access; all users authenticate.

---

## Part J — Master Attribute Catalogue

Fields available across the platform. `PII` column: whether it's personal data under DPDP Act.

| Field | Module | Type | Required | PII | Configurable per event | View | On receipt |
|---|---|---|---|---|---|---|---|
| Name | Identity | text | ● | ✓ | — | Self, Admin, Auditor | ✓ |
| Flat number | Society | text | ● | ✓ | — | Self, Admin, Auditor, Public (if disclosed) | ✓ |
| Email | Identity | email | ● | ✓ | — | Self, Admin | ✓ |
| Phone | Identity | tel | ○ | ✓ | — | Self, Admin | ○ |
| Occupancy role | Society | enum(owner,tenant,family) | ● | ○ | — | Self, Admin | — |
| Amount | Contribution | integer(₹) | ● | ○ | — | Self, Admin, Auditor, Public (if disclosed) | ✓ |
| Payment method | Payment | enum | ● | ○ | — | Self, Admin, Auditor | ✓ |
| UPI reference / UTR | Payment | text | ○ | ○ | — | Self, Admin, Auditor | ○ |
| Anonymous flag | Contribution | boolean | ● | ○ | ✓ | Self, Admin, Auditor | — |
| Contribution message | Contribution | text | ○ | ○ | ✓ | Public (if disclosed), Admin, Auditor | ○ |
| Adult count | Participation | integer | ○ | ○ | ✓ | Self, Admin | ○ |
| Child count | Participation | integer | ○ | ○ | ✓ | Self, Admin | ○ |
| Food preference | Participation | enum | ○ | ○ | ✓ | Self, Admin | — |
| Age category | Participation | enum | ○ | ○ | ✓ | Self, Admin | — |
| Team name | Participation | text | ○ | ○ | ✓ | Self, Admin, Public (if disclosed) | — |
| Volunteer role interest | Participation | multi-select | ○ | ○ | ✓ | Self, Admin | — |
| Age | Participation | integer | ○ | ✓ | ✓ | Self, Admin | — |
| Gender | Participation | enum | ○ | ✓ | ✓ | Self, Admin | — |
| Special requirement | Participation | text | ○ | ✓ | ✓ | Self, Admin | — |
| Receipt number | Receipt | text | ● (auto) | ○ | — | Self, Admin, Auditor | ✓ |
| Verified-by | Receipt | text | ● | ○ | — | Self, Admin, Auditor | ✓ |
| Status | Contribution | enum(pending,verified,failed) | ● | ○ | — | Self, Admin, Auditor | ✓ |
| Purpose | Event | text | ● | ○ | — | Public | ✓ |

**Field policy:**
- No custom user-defined fields at MVP (per §15 warning).
- Advanced admin can toggle catalogued optional fields per event template.
- Adding a NEW field to the catalogue requires a code change (deliberate friction).

---

## Part K — Contribution & Donation Requirement Model

### K.1 Contribution models supported
| Model | Description | When used |
|---|---|---|
| Voluntary open | Any amount ≥ minimum | Charity, festivals |
| Voluntary tiered | Suggested tiers + custom | Festivals, donation drives |
| Fixed equal | Same amount for every flat | Maintenance top-ups, security upgrades |
| Fixed per head | Amount × head count | Community meals, picnics |
| Milestone / phased | Multiple phased goals | Infra projects |
| Registration-fee-only | Amount collected as event fee | Sports, workshops |

### K.2 Privacy model (recommended simple + flexible)
Three-level toggle per contribution, configured per event by admin:

1. **Fully disclosed** — name + flat + amount visible on public reports (opt-in per contributor).
2. **Partial disclosure** — name + flat visible, amount hidden (or vice versa; admin picks).
3. **Anonymous** — nothing public; internal records intact with full identity for reconciliation, receipt, and audit.

**Default per contribution:** whatever the event's admin default is; contributor can override to "more private" but not "less private".

### K.3 Payment verification path
```
Initiated
  ↓
Payment Pending → (timeout) → Failed
  ↓
Payment Reported (UPI ref entered) OR Gateway Webhook Received
  ↓
Auto-verified (gateway matched) OR Manual verification queue
  ↓
Verified → Receipt generated → Archived
```
Also supports: Cancelled, Duplicate (linked to original), Refunded, Disputed.

### K.4 Template presets (MVP)
| Template | Cluster | Contribution model | Registration | Privacy default |
|---|---|---|---|---|
| Festival Contribution | A | Voluntary tiered | Off | Disclosed (opt-out) |
| Voluntary Donation | D | Voluntary tiered | Off | Anonymous (opt-in) |
| Fixed Contribution | A/F | Fixed equal | Off | Disclosed |
| Community Meal | B | Fixed per head | On (family) | Disclosed |
| Sports Registration | C | Registration fee | On (individual/team) | Disclosed |
| Picnic | B | Fixed per head | On (family) | Disclosed |
| Charity Drive | D | Voluntary open | Off | Anonymous (opt-in) |
| Emergency Fund | E | Voluntary open | Off | Disclosed |
| Infrastructure Project | F | Voluntary tiered + milestones | Off | Disclosed |
| Information-only | G | None | Optional RSVP | N/A |

### K.5 Receipt & Archive requirement decision (open Q for review)

Compared options:

| Option | Cost | Portability | Integrity | Complexity | Recommendation |
|---|---|---|---|---|---|
| Private git repo w/ PDFs | Free (GitHub free tier) | Excellent | Git SHA already tamper-evident | Low | **✅ MVP** |
| Private git repo w/ encrypted PDFs (age/gpg) | Free | Excellent | + confidentiality | Medium | P2 upgrade path |
| S3-compatible object storage (Backblaze B2 / Cloudflare R2) | ~₹0–100/mo | Good | Add SHA-256 sidecar | Low-Medium | P2 for volume growth |
| Self-hosted MinIO on society NAS | Free (electricity) | Good | Add SHA-256 sidecar | High | Not recommended (SPOF) |
| Annual archive package (ZIP) shared at AGM + printed | Free | Excellent | Physical + digital | Low | **✅ Always, alongside primary** |

**Recommendation:** Primary = private git repo + JSON index + SHA-256 hash file. Secondary = annual ZIP handed off at AGM. Migration path to object storage once footprint > 5 GB.

---

## Part L — Feature Registry (conceptual schema)

Every configurable feature is a row in a central catalogue:

```yaml
feature:
  id: F-CO12
  name: Anonymous Contribution
  category: Contribution Engine
  cluster: 4
  description: >
    Allows a contributor to hide their public identity while
    internal records retain full identity for reconciliation.
  status: MVP
  default_state: enabled
  applicable_clusters: [A, D, E, F]
  requires: []
  conflicts: []
  optional_dependencies: [F-CO13]
  configuration_scope:
    system: true
    event_type: true
    event: true
  visibility:
    resident: true
    admin: true
    auditor: true
    advanced_admin: true
  historical_data_behavior: preserve_regardless_of_toggle
  version: 1
  introduced_in: MVP
```

**Registry storage:** JSON/YAML file in repo (source-controlled, reviewable) + runtime DB copy for editable overrides. Advanced admin edits the DB copy; edits are diffed against the source-of-truth file and shown in audit log.

---

## Part M — Administration Requirements

### M.1 Society Admin (F-AD01)
- Event CRUD (draft → publish workflow with review step)
- Resident approval queue
- Post event updates
- Publish expense summary
- View reconciliation (read-only)
- Send announcements (P2)

### M.2 Financial Admin (F-AD02)
- Verify manual payments
- Log cash/cheque
- Handle reconciliation exceptions
- Regenerate receipts with reason
- Export CSVs
- Refund workflow (P3)

### M.3 Advanced Admin (F-AD04)
- Feature registry edit
- Event template CRUD
- Receipt template edit
- System-level toggles
- Payment provider config
- Backup/export triggers
- Config diff/audit viewer

### M.4 Never exposed through UI (developer-only)
- Database credentials
- Payment gateway secret keys (input only, never displayed after save)
- Encryption keys
- SMTP credentials
- Feature-registry schema (structure, not values)

---

## Part N — Edge Case Catalogue

### N.1 Payment edge cases
1. Same person contributes twice in same event → allowed; second is separate record with separate receipt.
2. Payment succeeds at gateway but our webhook fails → nightly reconciliation job pulls gateway ledger, matches by UTR.
3. Duplicate webhook for same payment → idempotent by gateway payment_id (F-PY07).
4. Event closes during ongoing payment → payment completes, receipt still issued, marked "late-arrival"; admin decides inclusion in totals.
5. Payment amount differs from expected (e.g., ₹5,000 target, ₹4,999 received) → surfaced as reconciliation exception.
6. UTR entered by contributor doesn't match any bank credit → stays pending; admin sees exception queue.
7. Refund requested → separate refund record; original receipt marked "refunded", refund receipt generated.

### N.2 Identity edge cases
1. Resident changes flat (moves within society) → historical records stay tied to previous flat; new records tie to new flat.
2. Owner + tenant both in same flat → both can log in; both can contribute independently; each gets own receipt.
3. Tenant leaves society → account disabled; historical records preserved; PII redacted on public views if requested.
4. Family member (child, spouse) contributes → linked to main account; receipt in their name.
5. Committee member becomes ex-committee → admin role revoked; historical audit-log entries preserved with role at time of action.

### N.3 Configuration edge cases
1. Anonymous option disabled after some contributions were anonymous → historical anonymous records stay anonymous; new contributions can no longer choose anonymous.
2. Contribution model changed mid-event (voluntary → fixed) → **blocked** by F-FR06 after first contribution.
3. Event configuration edited after publish → allowed for non-payment fields (description, image); blocked for payment-critical fields once contributions start.
4. Template updated after old events used it → old events retain snapshot; template is versioned.
5. Feature removed from registry → historical events using it still render correctly with cached snapshot.

### N.4 Receipt edge cases
1. Receipt generation fails at issue time → payment stays verified; receipt queued for retry; admin sees exception.
2. Receipt requires correction (wrong name/amount) → new revision issued, same number, old version archived, audit-logged.
3. Anonymous contributor requests to disclose later → allowed via admin; new receipt revision with name; audit-logged.
4. Anonymous contributor requests deletion → PII redacted; financial record retained under pseudonymized handle.
5. Bulk receipt regeneration (template change) → confirmation gate; per-file audit log entry.

### N.5 Operational edge cases
1. Original developer leaves → docs bundle (F-SU04) + full export (F-SU01) enable new custodian takeover.
2. Society committee changes → role reassignment via UI; no data reset.
3. Hosting provider changes → export/import via portable data format (F-SU05).
4. Payment provider changes → abstraction layer (F-SU06) swaps provider without code changes; historical data references old provider read-only.
5. Auth provider changes → magic link + OTP fall back to plain SMTP if third-party provider dies.
6. Domain name changes → receipts stored with immutable content; only view URL changes.
7. Google account (OAuth) service issues → OTP path remains available.

### N.6 Trust / dispute edge cases
1. Contributor claims paid but no record exists → admin cross-checks bank; if genuine, manually verifies + issues receipt with note.
2. Two contributors claim same UTR → both flagged; admin investigates (typo vs fraud).
3. Committee accused of misallocation → audit log + expense summary + auditor role provide evidence trail.
4. Refund requested for anonymous contribution → contributor proves identity to admin; standard refund flow.

---

## Part O — Requirement Prioritization

### Tier 1 — MVP (must ship v1)
All features tagged **MVP** in Part E. Highlights:
- Email OTP + magic link auth
- Society + flat registry with owner/tenant/family
- Event templates for clusters A, B, C, D, E, F, G
- Voluntary + fixed + tiered contribution models
- UPI (deep-link) + manual verification + cash/cheque log
- Unique receipt number + PDF + email delivery + regeneration + revision log
- Anonymous option + configurable disclosure
- Public progress + goal + contributor count
- Reconciliation dashboard + registration roster
- Feature registry + config lock post-first-contribution
- Event config snapshots
- Full data export ZIP + docs bundle
- Private-repo receipt archive with SHA-256 index
- Auditor read-only role

### Tier 2 — Phase 2
All features tagged **P2**. Highlights:
- Payment gateway auto-verify + webhook
- Waiting list + team registration + age categories
- WhatsApp share links + browser push
- Encrypted archive option
- Config diff viewer + "what-if" preview
- Recurring event series + multi-phase milestones
- Public contributor list (opt-in per event)
- Refund workflow

### Tier 3 — Phase 3 / Future
All features tagged **P3**. Highlights:
- Native mobile app (only if PWA insufficient)
- SMS notifications
- Recurring auto-debit
- Multi-society tenancy switcher
- Advanced analytics / cross-event dashboards

### Tier 4 — Explicitly avoid
All features tagged **AVOID** in Part E, plus §B.2 rejection list.

---

## Part P — Final Recommended Requirement Architecture

```
TVH Platform
│
├── Identity
│   ├── Auth (F-ID01–04)
│   ├── Sub-identities per flat (F-ID06)
│   └── Roles (F-ID07)
│
├── Society Registry
│   ├── Society profile (F-SO01)
│   ├── Flat directory (F-SO02)
│   └── Occupancy linking (F-SO03)
│
├── Event Engine
│   ├── Templates (F-EV01, versioned F-HS02)
│   ├── Lifecycle: draft → publish → active → close → archive (F-EV03–08)
│   ├── Config snapshots (F-HS01)
│   ├── Config lock (F-FR06)
│   └── Updates & posts (F-EV10)
│
├── Contribution Engine
│   ├── Models (F-CO01–08)
│   ├── Privacy: 3-level (F-CO12–13)
│   ├── Goals & progress (F-CO09–10)
│   └── Public visibility toggles (F-CO11)
│
├── Participation Engine
│   ├── Registration (F-PA01–05)
│   ├── Capacity + waiting list (F-PA07–08)
│   ├── Volunteer (F-PA09–10)
│   └── Registration fees (F-PA11–12)
│
├── Payment & Reconciliation
│   ├── UPI + manual + gateway (F-PY01–06)
│   ├── Idempotent webhook (F-PY07)
│   ├── Reconciliation dashboard (F-PY10)
│   └── Provider abstraction (F-SU06)
│
├── Financial Records
│   ├── Receipts (F-RC01–12)
│   ├── Archive subsystem (F-AR01–08)
│   └── Revision & audit (F-RC05–06)
│
├── Transparency & Reporting
│   ├── Resident view (F-RP01–02)
│   ├── Public view (F-RP03–05)
│   ├── Admin dashboards (F-RP06–07)
│   └── Auditor view (F-RP08)
│
├── Notifications
│   ├── Email transactional (F-NT01–05)
│   ├── WhatsApp share (F-NT07)
│   └── Push (F-NT08, P2)
│
├── Administration
│   ├── Society Admin (F-AD01)
│   ├── Financial Admin (F-AD02)
│   ├── Auditor (F-AD03)
│   ├── Advanced Admin (F-AD04)
│   └── Audit log (F-AD07)
│
├── Feature Registry & Configuration
│   ├── Registry storage (F-FR01)
│   ├── Multi-scope toggles (F-FR02–04)
│   ├── Dependency validation (F-FR05)
│   └── Change audit (F-FR07)
│
├── Historical Integrity
│   ├── Event snapshots (F-HS01)
│   ├── Template versioning (F-HS02)
│   └── Historical rendering (F-HS03)
│
├── Sustainability
│   ├── Export (F-SU01)
│   ├── Auto-backup (F-SU02)
│   ├── Restore (F-SU03, P2)
│   ├── Docs bundle (F-SU04)
│   ├── Portable schema (F-SU05)
│   └── Provider abstractions (F-SU06–07)
│
└── Security & Privacy
    ├── Transport & storage (F-SC01, F-SC07)
    ├── PII classification (F-SC02)
    ├── DSR handling (F-SC03)
    ├── Rate limiting, CSRF, CSP (F-SC04–06)
    ├── Admin 2FA (F-SC08, P2)
    └── DPDP alignment (F-SC09)
```

---

## Open Questions (for committee review before finalize)

1. **Q1** — Should Financial Admin be a separate person from Society Admin, or is one combined "Treasurer-Admin" role acceptable? *Recommendation: separate for audit hygiene.*
2. **Q2** — For anonymous contributions, should the Auditor role see real identity? *Recommendation: yes — auditors need it for financial audit; contributors are informed at consent time.*
3. **Q3** — Default disclosure for festival events: opt-out (public by default) or opt-in (private by default)? *Recommendation: opt-out for festivals, opt-in for charity.*
4. **Q4** — Should the receipt archive be a repo under the same GitHub org or a separate account? *Recommendation: same org, separate private repo, distinct access controls.*
5. **Q5** — Language: English only for MVP, or Marathi/Hindi as well? *Recommendation: English MVP, i18n-ready but multi-language P2.*
6. **Q6** — Currency: fixed to INR only, or design multi-currency schema? *Recommendation: INR only; schema stores currency code for future.*
7. **Q7** — Should we adopt a `.well-known/tvh-config.json` public endpoint exposing enabled features (for external audit tooling)? *Recommendation: P2.*

---

## Change Log
- **2026-08-21** — Initial draft in `temp/`. Awaiting committee review before moving to repo root.
