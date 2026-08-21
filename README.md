# 🐝 ta-vibehive

> **What's buzzing in your society?**

A configurable, mobile-first platform for managing society events, participation, contributions, donations, registrations, and community activities.

## 🎯 Vision

VibeHive is designed as a reusable platform for residential societies.

Instead of building a separate application for every event, administrators can create and configure events based on their specific requirements.

An event may include different combinations of features such as:

* 💰 Contributions
* ❤️ Donations
* 🕶️ Anonymous contributions
* 👤 Disclosed contributions
* 📝 Registration
* 👨‍👩‍👧 Family participation
* 🏆 Sports participation
* 🙋 Volunteer registration
* 🎟️ Capacity management
* 📊 Contribution progress
* 💳 Payment
* 📄 PDF receipts
* 🗂️ Long-term receipt records

## 🧩 Core Principle

```text
One Platform
     ↓
Multiple Event Types
     ↓
Configurable Features
     ↓
Only Relevant Features Visible
```

The platform should allow administrators to enable, disable, and configure features based on the requirements of each event.

## 🚀 Current status — Phase G-0 Foundation (slice G0-01)

**Priority Zero:** Ship Ganesh Chaturthi 2026 contribute + live dashboard **before Sept 14, 2026**.

- Stack: **static SPA on GitHub Pages + GitHub Actions + private data repos.** No Python, no server, no VPS. See [AGENTS.md](AGENTS.md) and `temp/tvh_plan.md §0.6` for lock rationale.
- What ships today (G0-01): app shell + 404, Community Warmth palette, Pages deploy, CI verify (gitleaks, CSP, LOC/size budget, no inline JS, no LLM SDK), `just` harness.

### Quickstart (maintainer workstation)

```powershell
# From ta_vibehive/ root:
just verify        # runs G1..G4 gates locally
just budget        # G3 · LOC + first-paint budget
just sec           # G4 · CSP, XCTO, no inline JS, gitleaks (if installed)
just serve         # local preview at http://localhost:4173
```

Install prerequisites once:

```powershell
winget install --id Casey.Just     # task harness (or: scoop install just)
winget install --id Gitleaks.Gitleaks   # optional but recommended for local G4
```

### Repo layout (G0-01)

```
index.html               # home shell
404.html                 # friendly not-found
assets/
  css/base.css           # Community Warmth palette
  images/*.png|jpg       # brand assets (logo, seals, letterhead)
.github/workflows/
  pages.yml              # Pages deploy on push to main
  ci.yml                 # G1..G4 verify on PR + push
scripts/
  check-budget.ps1       # G3 gate (LOC + first-paint size)
  check-sec.ps1          # G4 gate (CSP, XCTO, inline-JS, LLM SDK, gitleaks)
docs/
  deps.md                # shipped-dep justification log (budget 30)
  threats/G0-01.md       # per-slice threat model
temp/                    # gitignored — Copilot drafts, plan, requirements
AGENTS.md                # working rules that apply to every prompt
justfile                 # task harness
.gitleaks.toml           # secret scan config
```

## 🏗️ Project Approach

Development will follow this sequence:

1. Problem understanding
2. Global research
3. Event taxonomy
4. Requirement discovery
5. Feature catalogue
6. Requirement clustering
7. Feature dependency analysis
8. Configuration architecture
9. Requirement prioritization
10. UI/UX design
11. Technology selection
12. Development

## 🔒 Privacy

The system will support both:

* Disclosed contributions
* Anonymous public contributions

Anonymous contributions remain anonymous to other residents while appropriate internal financial records are maintained for payment reconciliation, receipts, and authorized society administration.

## 📦 Long-Term Vision

The platform is intended to be:

* Reusable every year
* Mobile-first
* Configurable
* Sustainable
* Low-cost
* Based primarily on free and open-source technologies
* Designed for society-owned data
* Independent of unnecessary vendor lock-in

---

🐝 **One Hive. All the Vibes.**
