# tvh_requirements_ui.md — UI / UX Requirement Architecture

**Project:** ta_vibehive (TVH) — Society Event & Contribution Platform
**Companion file:** `tvh_requirements.md` (functional — MUST be read first every prompt)
**Status:** LIVE — tracked at repo root; updated after every UI-touching slice.
**Last updated:** 2026-08-22 (G0-05 shipped, G1-01 shipped)

> **Master prompt §5 constraint:** No final screens, wireframes, colors, button placement, or visual designs are locked here. This file defines **UX principles, information architecture, interaction patterns, accessibility rules, and Gen-Z aesthetic direction** so that Phase-2 UI implementation is predictable and disciplined. Screen mockups come later.

> **Reading order rule (from `AGENTS.md`):** Every prompt re-reads BOTH requirements files first; UI changes must map to a UI requirement here AND a functional requirement in `tvh_requirements.md`.

---

## 0. UI Implementation Status (live)

Update after every UI-touching slice. Prepended before Section 1 intentionally — reality first, intent second.

### 0.1 Palette (LOCKED 2026-08-21 · Community Warmth)

`--bg #faf3ea` · `--ink #2a1a10` · `--muted #7d6858` · `--line #e8dcc7` · `--terra #a34328` · `--terra-soft #f2d8ca` · `--sage #6b8f5a` · `--sage-soft #dbeacc` · `--gold #c78f2a` · `--emerg #8f2318` · `--card #fff`. All shipped via CSS custom properties in `assets/css/base.css`. Any deviation must be recorded here first.

### 0.2 Shipped surfaces

| Surface | Slice | Path | Notes |
|---|---|---|---|
| Home shell | G0-02 | `/` (index.html) | Topbar (brand + EN/MR/HI language nav) · hero-card ("Coming soon" pill, terracotta accent, gold glow) · 3-card info-grid · floating theme picker stub · footer |
| Error page | G0-01 | `/404.html` | Same CSP posture · small brand tile · CTA back to home |
| Ganpati event page | G1-01 | `/g/ganpati-2026/` | Rendered from `config/ganpati_2026.json` via Alpine `x-text` bindings (never `x-html`); cluster A → `is-terra` tint; loading / error / content states; INR with Indian grouping; 4-tier grid + custom option |

### 0.3 Interaction rules verified in code

- **Skip link** present on every page (`.skip-link` targets `#main`).
- **Language toggle** persists to `localStorage.tvh.lang` with allowlist `['en','mr','hi']`; falls back to `en` on unknown value; updates `html[lang]`.
- **No inline styles or inline event handlers** — enforced by G4 CI + `tests/owasp.test.js` (Alpine `x-on:` / `@` bindings allowed).
- **No `x-html`** — enforced by G4. All Alpine text bindings use `x-text` only.
- **Reduced motion** honored via `@media (prefers-reduced-motion)` in `base.css` (glow animation disabled).
- **`[x-cloak]` display:none** applied so Alpine hydration doesn't flash unstyled interactive state.

### 0.4 Accessibility posture (WCAG AA target)

- Semantic landmarks: `<header role="banner">`, `<main id="main">`, `<footer>` (implicit contentinfo). Verified on index + 404 + event page.
- Language buttons expose `aria-pressed`; theme FAB exposes `aria-expanded` + `aria-controls`.
- All decorative glyphs use `aria-hidden="true"`.
- Contrast: `--ink` (#2a1a10) on `--bg` (#faf3ea) = 14.4:1 (AAA); `--terra` on `--card` = 6.8:1 (AA large + AA normal). Recorded here; automated contrast test lands in G3-01.

### 0.5 Deferred UI (per Priority Zero — do NOT ship before 2026-09-14)

Full MR/HI translated strings (only language toggle labels are localized at launch) · brand-explore theme swap · dashboard chart animations beyond linear progress bar · admin surface polish beyond verify queue · PDF receipt preview page · resident profile page.

---

## 1. UX North Star

> **Feels like Notion + Linear + Cred, not like a government portal.**

Three non-negotiable qualities:

1. **Calm** — no dark patterns, no urgency manufactured beyond real emergencies (Cluster E only), no shame-inducing "your neighbours have contributed" pressure.
2. **Confident** — every action shows exactly what will happen, why, to whom. No mystery loading, no ambiguous receipts, no "your request is being processed" limbo.
3. **Ownable** — a 65-year-old committee member and a 22-year-old resident both feel it's *theirs*. Not a corporate SaaS. Not a WhatsApp thread. Something in between.

---

## 2. Audience Model

| Persona | Age band | Digital literacy | Primary device | Primary need |
|---|---|---|---|---|
| **Gen-Z resident** ("Aarav, 24") | 18–28 | Fluent | Mobile-first | Contribute in <30 sec, forget until receipt arrives |
| **Millennial resident** ("Priya, 34") | 28–42 | Fluent | Mobile + desktop | Track contributions across family, transparency |
| **Committee volunteer** ("Ramesh uncle, 58") | 45–65 | Moderate | Mobile primarily, some desktop | Publish events without technical stress |
| **Senior resident** ("Mrs. Kamble, 68") | 60+ | Basic | Mobile, sometimes assisted | Large clear text, simple 3-step contribute flow |
| **Committee financial admin** ("Suresh, 52") | 40–60 | Moderate to fluent | Desktop preferred | Reconcile efficiently, export cleanly |
| **Auditor CA** | 40+ | High for their tools, low for new apps | Desktop | Read-only, exportable, printable |
| **Advanced admin / developer** | Any | Expert | Desktop | Feature registry, template editor |

**Design implication:** MVP is **mobile-first PWA**; desktop is a first-class layout, not an afterthought. Two persona groups (Gen-Z + committee volunteer) must both feel at home in the same UI.

---

## 3. Gen-Z Aesthetic Direction (2026-appropriate, sustainable)

Adopted patterns (with rationale — every one earns its place):

### 3.1 Visual language
| Pattern | Where | Why | Cost |
|---|---|---|---|
| **Bento grid dashboards** | Home, admin dashboards | Feels modern, scans well on mobile, invented for exactly this info density | Zero (CSS grid) |
| **Soft neumorphic cards + subtle depth** | Event cards | Warmer than flat design, still restrained | Zero |
| **Large typographic hierarchy** (display-size headings, generous line-height) | Event pages | Reads like a magazine, not a form | Zero |
| **Vibrant accent + calm neutral base** | Buttons, progress bars | Reads energetic without shouting | Zero |
| **Rounded corners (12–20px)** | Everything | Softens formality without infantilizing | Zero |
| **Motion-on-intent** (micro-interactions on tap, not on load) | Buttons, toggles, receipt reveal | Feedback without distraction; respects `prefers-reduced-motion` | Zero |
| **Dark mode + light mode + system** | Global | Non-negotiable Gen-Z expectation; also senior-eye-friendly | Zero (CSS variables) |
| **Emoji-as-icons for event clusters** (🪔 🏏 🎨 🚨 🌱 🍛 📣) | Event cards, category chips | Legible universally, no icon-font dependency | Zero |
| **Real photography or high-quality illustration for event heroes** | Event pages | Every event feels like *something*, not a form | Uses uploaded society photos; no stock library |
| **"Vibes" chips** (energetic, urgent, celebratory, quiet) | Emergency/donation events | Sets tone without emoji overload | Zero |

### 3.2 Explicitly rejected trends
| Trend | Why rejected |
|---|---|
| Glassmorphism everywhere | Accessibility-hostile on low-contrast, dated 2022 aesthetic |
| Neubrutalism (heavy black borders, chunky shadows) | Excludes senior residents; feels sarcastic in a financial context |
| Aggressive gradients (Y2K revival) | Poor readability; loud in a trust context |
| Anthropic/AI shimmer animations everywhere | Distracts from financial data, burns battery |
| Full-screen video hero | Sustainability + bandwidth cost |
| Gamification (badges, streaks, "you're on fire!") | Culturally inappropriate for donations |
| Storyfication of financial data (TikTok-style vertical feeds) | Confuses the audit trail |
| Dark-only or light-only lock-in | Both must work |
| Skeuomorphic receipts (paper-fold shadows, torn edges) | Cheap; real receipts are already in the PDF |

### 3.3 Sustainability constraints on aesthetic
- **No web fonts loaded from external CDNs** — use system font stack. (Privacy + performance + no Google Fonts tracking.)
- **No icon libraries larger than 20 KB gzip.**
- **Every image lazy-loaded, `srcset`-generated, WebP/AVIF with JPEG fallback.**
- **Total page weight budget: < 200 KB on first paint for resident event page** (compressed).
- **Zero third-party analytics on public pages** (see §11 privacy).
- **No animation loops > 3s duration or > 200ms per micro-interaction.**

---

## 4. Information Architecture

### 4.1 Top-level surfaces
1. **Home / Feed** — active events, urgency-first ordering.
2. **Event page** — the workhorse; morphs per configuration.
3. **My Contributions** — personal history, all receipts.
4. **Reports (public)** — transparency page per event.
5. **Directory (optional)** — society info; NOT a resident phone book by default (privacy).
6. **Admin console** — event CRUD, reconciliation.
7. **Advanced console** — feature registry, templates.
8. **Auth flow** — login, verify, approval-pending.

### 4.2 Navigation model
- **Mobile:** bottom nav (5 max: Home, Events, Contribute-CTA, My Records, Menu).
- **Desktop:** left sidebar with same items; secondary top bar for role switcher when user has multiple roles.
- **No hamburger menu for primary nav** — hides too much for a 220-user product.

### 4.3 Role-conditional navigation
| Role | Visible surfaces |
|---|---|
| Resident | Home, Events, My Records, Reports, Profile |
| Society Admin | + Admin Console (Events, Approvals, Updates) |
| Financial Admin | + Reconciliation |
| Auditor | + Audit view |
| Advanced Admin | + Advanced console |

Role switcher (top-right avatar menu) when user holds multiple roles. **Never mix roles in same UI surface** — every action must feel scoped to one role.

---

## 5. Screen Requirements (conceptual only, no visual design)

For each surface, this file defines the **information required, actions required, and interaction rules**. Actual layouts happen in Phase 2.

### 5.1 Home / Feed
- Show currently active events, ordered by: (a) Cluster E emergency first, (b) closing-soonest, (c) most recently published.
- Each event card shows: cluster emoji, name, one-line purpose, progress-if-enabled, "Ends in X days" chip, primary action.
- Empty state: friendly, informative ("No active events. Check back after the next AGM 🌱").
- No modal on load, no permission prompts, no cookie banner (we set no non-essential cookies — see §11).

### 5.2 Event page (the polymorphic workhorse)
Layout is composed from **feature modules** driven by the Feature Registry (§F-FR01 in `tvh_requirements.md`). Modules that render only when enabled:
- Hero (image, name, purpose, urgency chip)
- Description + updates timeline
- Contribution module (tiers, custom, anonymous toggle)
- Registration module (individual/family/team form)
- Volunteer signup module
- Progress module (goal, %, contributor count)
- Public contributor list (opt-in)
- Expense summary (post-event)
- Share via WhatsApp / copy link

Rules:
- Only ONE primary CTA visible at once (usually Contribute or Register).
- Contribution + registration NEVER in the same modal on mobile — they're separate flows.
- Every module has a small "Why is this shown?" info dot (transparency: tells resident this module is enabled because *X*).

### 5.3 Contribute flow (Gen-Z: <30 sec target)
Three-step maximum on mobile:
1. **Choose amount** (tap tier or type custom) + optional anonymous toggle.
2. **Choose method** (UPI apps deep-link, or bank transfer, or "I already paid — enter UTR").
3. **Confirm & get receipt** — success state shows receipt inline with a "Download PDF" and "Share via WhatsApp".

Design rules:
- No account required to *view* an event; login required only at Step 2.
- Login is inline (magic-link email in same screen), NOT a full-page redirect.
- Never lose entered amount on login redirect.
- "Skip to end" easter egg for power users (Alt+Enter → last tier + last method).
- Every currency amount displayed with `₹` prefix + thousands separator per Indian numbering system (1,00,000 not 100,000).

### 5.4 Registration flow
- Progressive disclosure: essential fields visible, optional fields collapsed.
- Head-count uses steppers, not free text.
- Team registration on sports events uses a shareable invite link — captain fills team once, members join via link.
- Food preference is a single-select chip strip, not a dropdown.
- Waiting-list state shown clearly with "You're #4 on the waiting list — you'll be auto-promoted if a spot opens" copy.

### 5.5 My Contributions
- Chronological list, filterable by event/year.
- Each row: event, amount, status chip (Pending/Verified/Failed), Download-PDF icon.
- Empty state links back to Home ("You haven't contributed to any event yet. Here's what's active →").

### 5.6 Reports (public)
- One page per event.
- Only enabled modules render (goal, total, contributor count, expense summary).
- Anonymous contributors shown as "Anonymous" if public list is enabled.
- Direct link is shareable; no login required to view (society AGM transparency).

### 5.7 Admin console — Society Admin
- Bento dashboard: today's contributions, active events, pending approvals, recent events.
- Event creation is a wizard, NOT a monster form:
  1. Choose cluster / template
  2. Basic info (name, dates, image)
  3. Configure enabled features (with dependency warnings inline)
  4. Preview as resident
  5. Publish (or save draft)
- Every dependency warning uses the "gentle friction" pattern: not a red error, but an amber "This won't work with your current config because…" hint with a one-click fix.

### 5.8 Reconciliation dashboard — Financial Admin
- Three columns: Pending verification, Verified today, Exceptions.
- Each pending row shows: contributor, amount, method, UTR, "Match to bank" quick-search.
- Verify action is a **two-tap confirm** (not one-tap — audit hygiene).
- Bulk verify for imported bank statements (P2).

### 5.9 Advanced console
- Feature Registry table with search + filter by cluster.
- Template editor: side-by-side "template config" ↔ "how it looks to residents" preview.
- Receipt template editor: WYSIWYG-lite; test-render with sample data.
- Every save produces a diff view + confirmation.

### 5.10 Auth surfaces
- Login: email input → "Send code" → 6-digit code entry OR "Use magic link" fallback.
- Approval-pending state after signup: "Waiting for committee to approve — usually within 24h. We'll email you."
- Session expiry: gentle re-auth in same context, no redirect to homepage.

---

## 6. Interaction Patterns

### 6.1 Feedback timing
| Action | Feedback |
|---|---|
| Tap primary button | Ripple + haptic hint (CSS only) < 100ms |
| Form submit | Button turns to spinner state; input locks; never full-page reload |
| Payment initiated | Progress card with clear "waiting for your UPI app" copy |
| Payment verified | Success reveal with receipt animation (subtle, single motion, respects reduced-motion) |
| Error | Inline, contextual, human-language, with next step ("The UTR you entered doesn't match. Check the last 12 digits of your UPI transaction ID.") |

### 6.2 Confirmations
- Destructive actions: two-step (button → confirm modal with explicit consequence text).
- Financial verification: two-tap confirm.
- Config changes that affect published events: preview + "affects N residents" warning.
- Config changes locked after first contribution: hard-block with explanation, not "contact developer".

### 6.3 Empty states, error states, offline states
- **Empty:** always show *why* + *what next*.
- **Error:** always show *what happened* + *what user can do* + *how to reach admin*.
- **Offline:** page-level offline banner; local-first read of already-loaded events; explicit "you're offline, contributions will fail" on payment attempt.
- **Rate-limited:** friendly, tells user when they can retry.

### 6.4 Search
- Global search: `Cmd/Ctrl-K` opens command palette (advanced admins expect this).
- Event list search: instant client-side filter, no server round-trip.

---

## 7. Accessibility (non-negotiable)

**Target:** WCAG 2.2 AA across the board, AAA where cheap.

| Requirement | Rule |
|---|---|
| Color contrast | AAA for body text (7:1), AA for UI chrome (4.5:1). All accent colors have a verified contrast pair. |
| Keyboard navigation | Every action reachable by keyboard. Visible focus ring (custom, not the ugly default, but present). |
| Screen readers | Semantic HTML first, ARIA only where needed. Every form field labeled. Every icon-only button has `aria-label`. |
| Motion | Respect `prefers-reduced-motion: reduce` — kill all decorative animation. |
| Font size | 16px minimum body; user can zoom to 200% without horizontal scroll. |
| Touch targets | 44×44 CSS pixels minimum on mobile. |
| Language | HTML `lang` attribute; ready for `lang="mr"` / `lang="hi"` in P2. |
| Forms | Errors announced via `aria-live`. Never rely on color alone. |
| PDFs (receipts) | Tagged PDF; text-selectable; not just an image. |
| Currency + numbers | Read aloud correctly ("five thousand rupees" not "five zero zero zero"). |

**Explicit target:** a senior resident using default Android accessibility + Chrome zoom 150% completes a contribution without asking for help.

---

## 8. Responsiveness

| Breakpoint | Use |
|---|---|
| < 400px | Small phones (design for this first) |
| 400–767px | Standard phones |
| 768–1023px | Tablets, small laptops (single-column with more padding) |
| 1024–1439px | Standard desktop (sidebar + main) |
| ≥ 1440px | Large desktop (sidebar + main + optional context pane on admin surfaces) |

Rules:
- No horizontal scroll ever except intentional carousels.
- Tables become card-lists < 768px.
- Modals become full-screen sheets < 768px.
- Every layout tested at 320px width (accessibility zoom edge case).

---

## 9. PWA Requirements

- Installable (Web App Manifest with proper icons + `theme_color` matching current mode).
- Service Worker for offline reads of already-visited event pages + own receipts (cached PDFs).
- **Never** cache payment endpoints or admin actions offline.
- App shell < 50 KB.
- Cold start < 2s on 4G.
- No push notifications at MVP (see functional §F-NT08 P2).

---

## 10. Copy & Tone Guidelines

Voice: **direct, warm, adult**. Not corporate, not childish.

| Do | Don't |
|---|---|
| "Contribute" | "Chip in!" |
| "Your receipt is ready" | "Yay! 🎉🎉🎉 Receipt unlocked!" |
| "This event is closed" | "Sorry! You're too late 😢" |
| "Payment couldn't be verified. Try entering the UTR again." | "Oops! Something went wrong." |
| "Only the committee can see who contributed anonymously." | "Don't worry, we've got you 😉" |
| "Ends in 3 days" | "HURRY! Only 3 days left!!!" (except Cluster E emergency, and even then, calmly) |

Numbers: **always** show currency prefix, Indian grouping, no unnecessary decimals for whole rupees.

Dates: **DD MMM YYYY** for humans, ISO in metadata. Always with day-of-week when scheduling relevance ("Sat, 14 Sep 2027").

Times: 12-hour with lowercase am/pm.

Never use dark patterns:
- No "Are you sure you want to give up?" on close.
- No pre-checked "public list" checkbox.
- No hidden urgency ("2 people are viewing this event").
- No fake social proof.

---

## 11. Privacy & Trust in the UI

- No cookie banner because we set no non-essential cookies. If we ever do, real consent, not "accept all".
- No third-party analytics on resident-facing pages. If measurement is needed, self-hosted, IP-anonymized.
- Every "public" data point shows an inline hint of who sees it ("Visible to all residents" / "Only to admins").
- Anonymous contribution UI shows exactly what will and will not be public before the resident confirms.
- Session security: last-login timestamp shown in profile; clear list of logged-in devices with revoke.
- Never display payment secrets, admin tokens, or gateway keys in UI after save.

---

## 12. UX Content Rules per Cluster

| Cluster | Tone | Hero visual | Primary CTA copy | Notification urgency |
|---|---|---|---|---|
| A Festival | Warm, celebratory (not shouty) | Society festival photo | "Contribute" | Standard |
| B Social | Practical, friendly | Real photo / illustration | "Register" | Standard |
| C Sports | Energetic, focused | Sport-specific illustration | "Register team" / "Register" | Standard |
| D Donation | Calm, purposeful | Cause-relevant photo | "Donate" | Standard |
| E Emergency | Clear, urgent, non-panicked | Neutral icon + amber accent | "Contribute now" | Elevated (larger banner, top of feed) |
| F Infra | Confident, transparent | Project photo/render | "Support this project" | Standard |
| G Non-Financial | Informative | Simple graphic | "RSVP" / "I'll volunteer" | Standard |

**Cluster E specifically must NOT use red flashing / countdown timers.** The urgency is communicated through position (top of feed), a persistent amber banner, and one line of copy. That's it. Emergencies deserve calm competence, not theater.

---

## 13. Admin UX Principles

1. **No sudden power.** New admins get a guided setup once, not a firehose.
2. **Every setting has a "what happens if" preview.**
3. **Every irreversible action names itself.** "This will lock the config for 220 residents. Continue?"
4. **Audit log always reachable from every settings screen.**
5. **Advanced console feels different** (denser info, keyboard-first) so admins know they're in power-user mode.

---

## 14. Receipt UX (PDF)

Reference: attached booking receipt sample sets the tone — **classical, restrained, elegant** with double-border, serif typography, society seal.

Rules:
- Match the visual restraint of the sample.
- Society seal / stamp image mandatory.
- Booking ID / Receipt number in a monospace-esque display, large enough to read on print.
- Every field label in small caps, value in body.
- Status ("CONFIRMED" / "REFUNDED" / "REVISED") as a soft pill, not a shouty stamp.
- A5 landscape default; A4 portrait alternate template.
- Print-safe: no background images required for legibility.
- Text-selectable, screen-reader friendly (tagged PDF).
- Society PAN + registration number in footer.
- Consistent margin so seal never collides with content.
- Version 2+ receipt for a payment carries a small "Revised 2 of N" note.

---

## 15. Component Inventory (conceptual)

Not a design system doc — just the components we know we need. Actual visual spec in Phase 2.

- Event card (compact / expanded)
- Progress bar (with goal marker)
- Amount tier selector
- Currency input (auto-formatted ₹)
- Anonymous toggle with inline explanation
- Head-count stepper
- Team invite share link
- Payment method picker (UPI apps grid + bank + "I already paid")
- Receipt reveal card
- Reconciliation row
- Dependency warning inline
- Feature toggle row (with locked-state)
- Role switcher
- Auth code input (6-digit segmented)
- Command palette
- Confirmation modal (financial and destructive variants)
- Announcement banner (info / amber / emergency)
- Audit-log timeline entry
- Empty / error / offline states

---

## 16. What This File Does NOT Contain

Per master prompt §5, this file **excludes**:
- Actual color hex values
- Exact typography scale
- Wireframes or screenshots
- Component-library choice (Radix / shadcn / Tailwind UI / custom)
- Framework choice (React / Svelte / SolidJS / plain HTML)
- Icon library choice
- Specific animation durations beyond the max
- Grid units and spacing scale

These are deliberate Phase-2 decisions once the requirement architecture (this file + `tvh_requirements.md`) is approved.

---

## 17. UI-to-Functional Traceability (sample rows — full matrix built in Phase 2)

| UI requirement | Functional requirement backed |
|---|---|
| Contribute flow < 30s, 3 steps | F-CO01–08, F-PY01–06, F-RC03 |
| Anonymous toggle inline | F-CO12, F-CO13 |
| Bento home feed | F-EV07, F-EV10, F-CO10 |
| Reconciliation columns | F-PY10, F-PY03 |
| Feature registry table | F-FR01–04 |
| Auth: magic link + OTP inline | F-ID01, F-ID02 |
| Receipt reveal card | F-RC02, F-RC03, F-RC07 |
| PDF matches sample | F-RC02, F-RC12 |
| Public reports page | F-RP03–05 |
| Auditor read-only view | F-RP08, F-ID07 |

---

## 18. Open Questions (for committee review)

1. **U-Q1** — Should the app show a light or dark theme by default? *Recommendation: `system` — respects OS preference.*
2. **U-Q2** — Do we want a physical brand mark / logo before v1 ships, or use a wordmark? *Recommendation: wordmark for MVP; commissioned logo P2.*
3. **U-Q3** — Should we support English + Marathi + Hindi in MVP? *Recommendation: English MVP, i18n scaffold present so P2 doesn't need refactor.*
4. **U-Q4** — For contribution progress, show percentage of goal OR absolute total OR both? *Recommendation: absolute total + optional percentage; committee toggles per event.*
5. **U-Q5** — Should the "public contributor list" (when opt-in) show flat numbers or just names? *Recommendation: names only by default; flat-number visibility separately configurable.*
6. **U-Q6** — Command palette (Cmd-K) for residents too, or admin-only? *Recommendation: admin + advanced-admin only for MVP.*

---

## Change Log
- **2026-08-21** — Initial draft in `temp/`. Awaiting committee review before moving to repo root.
