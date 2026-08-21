# ta_vibehive · task harness
# Install `just` on Windows: winget install --id Casey.Just  (or scoop install just)
# All recipes shell out to PowerShell for cross-platform parity on the maintainer's box.

set shell := ["pwsh", "-NoProfile", "-Command"]
set windows-shell := ["pwsh", "-NoProfile", "-Command"]

# Show recipes
default:
    @just --list

# G1..G4 aggregate — refuses to exit 0 if any gate fails.
verify: test ui budget sec
    Write-Host "✓ all gates passed" -ForegroundColor Green

# G1 · functional tests (Node-based unit tests land in G0-02+)
test:
    Write-Host "G1 · functional tests — no tests yet in G0-01" -ForegroundColor Yellow

# G2 · UI walkthrough (Playwright + Storybook land in G0-02+)
ui:
    Write-Host "G2 · UI — no stories yet in G0-01; run 'just serve' to view manually" -ForegroundColor Yellow

# G3 · sleek budget check
budget:
    pwsh -NoProfile -File scripts/check-budget.ps1

# G4 · secure baseline (gitleaks + inline-JS grep + CSP presence)
sec:
    pwsh -NoProfile -File scripts/check-sec.ps1

# Local static server on http://localhost:4173 (Python 3 required)
serve port="4173":
    Write-Host "Serving on http://localhost:{{port}} (Ctrl-C to stop)" -ForegroundColor Cyan
    python -m http.server {{port}} --bind 127.0.0.1

# Clean caches / temp build artifacts
clean:
    if (Test-Path _site) { Remove-Item -Recurse -Force _site }
    Write-Host "clean done" -ForegroundColor Green
