#requires -Version 5.1
<#
.SYNOPSIS
    G4 gate · Security baseline (local mirror of CI checks).

.DESCRIPTION
    Runs the same fast checks that CI runs, so `just verify` catches regressions
    before push:
      - Content-Security-Policy meta present on every shipped HTML
      - X-Content-Type-Options meta present
      - no inline event handlers (onclick=, onload=, ...)
      - no <script> with inline body
      - no LLM SDK marker in shipped assets
      - gitleaks (if installed)
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== G4 · security baseline ==" -ForegroundColor Cyan
$fail = 0

# 1. CSP + XCTO meta on every shipped HTML.
$htmls = Get-ChildItem -Path . -Filter *.html -File
foreach ($h in $htmls) {
    $body = Get-Content -Raw -LiteralPath $h.FullName
    if ($body -notmatch 'Content-Security-Policy') {
        Write-Host ("  [FAIL] {0}: missing Content-Security-Policy meta" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
    if ($body -notmatch 'X-Content-Type-Options') {
        Write-Host ("  [FAIL] {0}: missing X-Content-Type-Options meta" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
}

# 2. Inline event handlers.
$evtHits = Select-String -Path *.html -Pattern 'on(click|load|error|submit|change|input|mouseover|focus|blur)=' -SimpleMatch:$false -ErrorAction SilentlyContinue
if ($evtHits) {
    foreach ($m in $evtHits) {
        Write-Host ("  [FAIL] {0}:{1}: inline event handler" -f $m.Path, $m.LineNumber) -ForegroundColor Red
    }
    $fail = 1
}

# 3. Inline <script> body.
foreach ($h in $htmls) {
    $body = Get-Content -Raw -LiteralPath $h.FullName
    # Match <script ...> not immediately closed and containing non-whitespace before </script>.
    if ($body -match '<script(?![^>]*\bsrc=)[^>]*>\s*\S') {
        Write-Host ("  [FAIL] {0}: inline <script> body -- use external src only" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
}

# 4. LLM SDK marker in shipped assets.
$llmPattern = 'openai|anthropic|langchain|@ai-sdk'
$llmHits = @()
$llmHits += Select-String -Path *.html -Pattern $llmPattern -ErrorAction SilentlyContinue
if (Test-Path assets) {
    $llmHits += Get-ChildItem -Path assets -Recurse -File -Include *.js, *.css, *.html -ErrorAction SilentlyContinue |
        Select-String -Pattern $llmPattern -ErrorAction SilentlyContinue
}
if ($llmHits) {
    foreach ($m in $llmHits) {
        Write-Host ("  [FAIL] {0}:{1}: LLM SDK marker" -f $m.Path, $m.LineNumber) -ForegroundColor Red
    }
    $fail = 1
}

# 5. gitleaks (optional - skip cleanly if not installed).
$gl = Get-Command gitleaks -ErrorAction SilentlyContinue
if ($gl) {
    Write-Host "  running gitleaks..." -ForegroundColor DarkGray
    & gitleaks detect --no-banner --redact --exit-code 1 --config .gitleaks.toml
    if ($LASTEXITCODE -ne 0) { $fail = 1 }
} else {
    Write-Host "  ! gitleaks not installed - skipped locally (CI still enforces)" -ForegroundColor Yellow
}

if ($fail -ne 0) {
    Write-Host "  [FAIL] security baseline failed" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] security baseline passed" -ForegroundColor Green
exit 0
