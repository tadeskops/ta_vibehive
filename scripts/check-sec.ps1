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

# 1. CSP + XCTO + Referrer-Policy + Permissions-Policy on every shipped HTML.
$htmls = Get-ChildItem -Path . -Filter *.html -File
$requiredMeta = @('Content-Security-Policy','X-Content-Type-Options','Referrer-Policy','Permissions-Policy')
foreach ($h in $htmls) {
    $body = Get-Content -Raw -LiteralPath $h.FullName
    foreach ($rm in $requiredMeta) {
        if ($body -notmatch [regex]::Escape($rm)) {
            Write-Host ("  [FAIL] {0}: missing {1} meta" -f $h.Name, $rm) -ForegroundColor Red
            $fail = 1
        }
    }
    if ($body -match 'unsafe-inline|unsafe-eval') {
        Write-Host ("  [FAIL] {0}: CSP contains unsafe-inline / unsafe-eval" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
    if ($body -notmatch "default-src 'self'") {
        Write-Host ("  [FAIL] {0}: CSP missing default-src 'self'" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
    if ($body -notmatch "frame-ancestors 'none'") {
        Write-Host ("  [FAIL] {0}: CSP missing frame-ancestors 'none'" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
}

# 2. Inline event handlers (allow Alpine x-on: and @ bindings via strip).
foreach ($h in $htmls) {
    $body = Get-Content -Raw -LiteralPath $h.FullName
    $stripped = $body -replace 'x-on:[a-z]+=', 'BLANK=' -replace '@[a-z]+=', 'BLANK='
    if ($stripped -match 'on(click|load|error|submit|change|input|mouseover|focus|blur|keydown|keyup)\s*=') {
        Write-Host ("  [FAIL] {0}: inline event handler" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
}

# 3. Inline <script> body.
foreach ($h in $htmls) {
    $body = Get-Content -Raw -LiteralPath $h.FullName
    if ($body -match '<script(?![^>]*\bsrc=)[^>]*>\s*\S') {
        Write-Host ("  [FAIL] {0}: inline <script> body -- use external src only" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
}

# 4. Dangerous DOM sinks in assets/js + lib.
$sinkPatterns = 'innerHTML\s*=|outerHTML\s*=|document\.write|x-html\s*=|\beval\s*\(|new\s+Function\s*\('
$sinkFiles = @()
$sinkFiles += Get-ChildItem -Path assets\js -Recurse -File -Include *.js -ErrorAction SilentlyContinue
$sinkFiles += Get-ChildItem -Path lib -Recurse -File -Include *.js -ErrorAction SilentlyContinue
foreach ($f in $sinkFiles) {
    $body = Get-Content -Raw -LiteralPath $f.FullName
    if ($body -match $sinkPatterns) {
        Write-Host ("  [FAIL] {0}: dangerous DOM sink" -f $f.FullName) -ForegroundColor Red
        $fail = 1
    }
}
foreach ($h in $htmls) {
    $body = Get-Content -Raw -LiteralPath $h.FullName
    if ($body -match 'x-html\s*=|document\.write') {
        Write-Host ("  [FAIL] {0}: dangerous DOM sink" -f $h.Name) -ForegroundColor Red
        $fail = 1
    }
}

# 5. LLM SDK marker in shipped assets + lib.
$llmPattern = 'openai|anthropic|langchain|@ai-sdk'
$llmHits = @()
$llmHits += Select-String -Path *.html -Pattern $llmPattern -ErrorAction SilentlyContinue
if (Test-Path assets) {
    $llmHits += Get-ChildItem -Path assets -Recurse -File -Include *.js, *.css, *.html -ErrorAction SilentlyContinue |
        Select-String -Pattern $llmPattern -ErrorAction SilentlyContinue
}
if (Test-Path lib) {
    $llmHits += Get-ChildItem -Path lib -Recurse -File -Include *.js -ErrorAction SilentlyContinue |
        Select-String -Pattern $llmPattern -ErrorAction SilentlyContinue
}
if ($llmHits) {
    foreach ($m in $llmHits) {
        Write-Host ("  [FAIL] {0}:{1}: LLM SDK marker" -f $m.Path, $m.LineNumber) -ForegroundColor Red
    }
    $fail = 1
}

# 6. gitleaks (optional - skip cleanly if not installed).
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
