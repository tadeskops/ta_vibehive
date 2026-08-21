# ta_vibehive · Community Warmth

Configurable event, contribution and receipt platform for
**The Address Co-operative Housing Society Ltd., Baner (Pune)** —
and reusable by any cooperative housing society.

**Live target:** GitHub Pages (`https://tadeskops.github.io/ta_vibehive/`).
**Runtime:** static HTML + ES2022 modules + one 4 KB gzipped CSS.
**Cost:** ₹0/month. **Vendors:** zero third-party JavaScript.

---

## What it does

One reusable platform → many configurable event types → each event
enables only the features it actually needs.

Templates shipped in v0.1:

| Cluster              | Template            | Example                                          |
| -------------------- | ------------------- | ------------------------------------------------ |
| Festival             | `festival`          | Ganesh Chaturthi, Diwali, Holi, Navratri         |
| Social               | `social`            | Society picnic, community dinner, children's day |
| Sports               | `sports`            | Cricket tournament, badminton, chess             |
| Voluntary donation   | `donation`          | Charity drive, community welfare                 |
| Emergency collection | `emergency`         | Roof repair, disaster support                    |
| Infrastructure       | `infra`             | Solar rooftop, garden, security upgrade          |

Every event is **created by a person with the right role**. Nothing about
the events is hard-coded in the source. Add a new template by editing
`config/event-templates.json` — no code change required.

---

## Access model — 5 tiers

Configured in `config/roles.json`; every action is checked against
`permissions[<action>]` before it fires.

1. **Admin** — system owner. Feature toggles, roles, branding, receipt
   archive settings. Never runs day-to-day event ops.
2. **Management Committee** — elected office bearers. Publish events,
   verify contributions, close events, sign receipts.
3. **Sub-Committee** — Cultural / Sports / Volunteers. Draft and edit
   events under their cluster.
4. **Society Manager** — on-site staff. Records offline (cash/cheque)
   contributions, generates duplicate receipts, prints reports.
5. **Resident** — contributes, registers, downloads own receipts, sees
   permitted public boards.

The permission matrix is visible under **Admin → Roles & permissions**.

---

## Feature registry

Every capability is a row in `config/features.json` with:

- `id`, `cluster`, `label`, `scope` (`system` | `event`)
- `default` (on/off), optional `requires_role`, optional `depends_on`

Admins toggle system-scope features from **Admin → Feature registry**
(persists in `localStorage` in v0.1; a private data repo will hold the
merged config in v0.2).

Event-scope features are set per event in the event editor. Dependencies
are validated on save — e.g. `contribution.per_head` requires
`registration.count`, or the save is rejected.

---

## Receipts

- Generated **only after** Management Committee verifies the payment.
- Deterministic ID: `TA-<PURPOSE>-<YYYY>-<MM>-<DD>-<HHMMSS>-<SEQ4>-<HASH8>`.
- Rendered on-page with society letterhead + `TaStampBlueOverlay.png`
  watermark + `TaStampBlue.png` stamp corner.
- Downloadable as PDF via the browser print engine — **no third-party
  PDF library**, so no supply-chain surface.
- Verify hash printed on every receipt for tamper detection.
- Archive target (private repo, e.g. `tadeskops/tvh_record`)
  is a config field, not a code path.

---

## Architecture

```
index.html                    SPA shell, strict CSP, no inline JS/CSS
manifest.webmanifest          PWA
assets/
  css/base.css                One file. Community Warmth tokens + components.
  js/
    app.js                    Bootstrap, chrome, route table
    router.js                 Hash-based router (SPA works on GH Pages)
    dom.js                    createElement helpers (no innerHTML)
    store.js                  cfg (read-only JSON) + local (localStorage)
    auth.js                   session/login/logout adapter
    rbac.js                   permission check against roles.json
    features.js               feature registry + dependency validation
    events.js                 event/contribution CRUD + lifecycle
    receipts.js               receipt minting + verify hash
    views/
      home.js  events.js  event.js  contribute.js
      admin.js receipt.js login.js
config/
  society.json  roles.json  features.json  event-templates.json
.github/workflows/
  pages.yml                   Static deploy
  ci.yml                      G1..G4 gates (CSP, LOC, gz budget, DOM sinks)
```

### Design constraints (enforced by CI)

- **CSP** `default-src 'self'`, no `unsafe-inline`, no `unsafe-eval`,
  `frame-ancestors 'none'`.
- **No** `innerHTML`, `outerHTML`, `document.write`, `eval`,
  `new Function` — every node is built with `document.createElement`
  and `textContent` (`assets/js/dom.js`).
- **No** inline `<script>` bodies, no `onclick=`.
- **LOC ≤ 2500** across `assets/` + `*.html`. **CSS ≤ 10 KB gzipped**.
  **First-paint ≤ 150 KB gzipped**.

---

## Local development

No build step.

```powershell
cd ta_vibehive
python -m http.server 8080     # any static server works
# then open http://localhost:8080/
```

Sign in from the top-right — v0.1 ships a demo persona picker
(admin / management / sub-committee / manager / resident).
Production tier will swap in email OTP via a GitHub Action + JWT session.

---

## Deploying

Push to `main`. `.github/workflows/pages.yml` publishes `index.html`,
`404.html`, `manifest.webmanifest`, `assets/`, `config/` to GitHub Pages.
No secrets required.

The private receipt archive lives in a **separate** repository, referenced
by `config/society.json → receipts.archive_repo`. The archive publisher
(GitHub Action) will land in v0.2 and only fires after a receipt is
minted (verified) — code path documented but not yet wired.

---

## Roadmap

- **v0.1 (this drop)** — SPA shell, roles, feature registry, event
  templates + editor, contribution flow, on-screen receipts with stamp,
  audit log, admin console.
- **v0.2** — email OTP via GH Action; receipt push to private archive
  repo; multi-language (EN / MR / HI) UI strings.
- **v0.3** — public verify portal (`/verify/<receipt_id>`); waitlist
  and capacity flows; expense transparency board.

---

## Licence

Society-owned data. Code MIT unless a stricter licence is added.
