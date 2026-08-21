# Direct-dependency log

Every direct dep the app **ships to the browser** must be listed here with a
one-line justification. Budget = 30 (per `AGENTS.md §4.1`).

Devtime dependencies (Playwright, gitleaks, semgrep, `just`, `html-validate`)
are **not** counted against the ship budget but are noted at the bottom for
reproducibility.

## Runtime (shipped to the browser)

_None yet in slice G0-01 — the shell is static HTML + CSS only._

## Planned runtime (arriving G0-02+)

| Dep | Version | Purpose | Slice | Ship weight (gzipped) |
|---|---|---|---|---|
| Alpine.js | 3.14.x | Client-side reactivity for HTMX-style islands | G0-02 | ~15 KB |
| qrcode-generator | 1.4.x | Client-side QR for UPI deep-link | G1-03 | ~4 KB |

Every planned dep must:

1. Be vendored under `assets/vendor/` (no CDN fetches at runtime — CSP `script-src 'self'`).
2. Have its SHA-384 hash pinned in `assets/vendor/HASHES.md`.
3. Be re-vendored via a documented `scripts/vendor-*.ps1` reproducible script.

## Devtime (not counted against ship budget)

| Tool | Purpose |
|---|---|
| `just` (Casey.Just) | Task harness — `just verify` runs G1..G4 |
| `pwsh` 5.1+ | Script host |
| `python` 3.11+ | Local static server (`just serve`) |
| `gitleaks` | Secret scan |
| `html-validate` | HTML well-formedness |
| Playwright | UI walkthrough (arrives G0-02) |
| semgrep | Code linting for security anti-patterns (arrives G0-05) |
