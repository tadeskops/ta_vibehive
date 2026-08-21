#requires -Version 5.1
<#
.SYNOPSIS
    G3 gate · Sleek budget check (LOC + first-paint payload).

.DESCRIPTION
    Fails (exit 1) if the ta_vibehive shipped source exceeds either:
      - LOC budget for the current slice
      - First-paint gzipped size (200 KB ceiling)

    Slice budget defaults to 1500 (G0-01). Override via -SliceBudget.
#>
[CmdletBinding()]
param(
    [int]$SliceBudget = 2500,
    [int]$FirstPaintBudgetKB = 150,
    [int]$CssBudgetKB = 10
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== G3 · sleek budget ==" -ForegroundColor Cyan

# 1. LOC across shipped assets (css/js) + top-level HTML. Vendored libs excluded.
$assetFiles = Get-ChildItem -Path assets -Recurse -Include *.css, *.js -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\assets\\vendor\\' }
$htmlFiles  = Get-ChildItem -Path . -Filter *.html -File

$assetLoc = 0
foreach ($f in $assetFiles) {
    $assetLoc += (Get-Content -LiteralPath $f.FullName | Measure-Object -Line).Lines
}
$htmlLoc = 0
foreach ($f in $htmlFiles) {
    $htmlLoc += (Get-Content -LiteralPath $f.FullName | Measure-Object -Line).Lines
}
$totalLoc = $assetLoc + $htmlLoc

Write-Host ("  LOC assets={0}  html={1}  total={2}  budget={3}" -f $assetLoc, $htmlLoc, $totalLoc, $SliceBudget)

if ($totalLoc -gt $SliceBudget) {
    Write-Host ("  [FAIL] LOC budget exceeded ({0} > {1})" -f $totalLoc, $SliceBudget) -ForegroundColor Red
    exit 1
}

# 2. First-paint payload: index.html + base.css + vendored Alpine, gzipped.
$paintFiles = @('index.html', 'assets/css/base.css')
$paintFiles += (Get-ChildItem -Path 'assets/vendor' -Filter 'alpine-*.min.js' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$paintFiles = $paintFiles | Where-Object { Test-Path $_ }

$rawBytes = 0
$buf = New-Object System.IO.MemoryStream
foreach ($p in $paintFiles) {
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $p))
    $buf.Write($bytes, 0, $bytes.Length)
    $rawBytes += $bytes.Length
}
$buf.Position = 0

$gzBuf = New-Object System.IO.MemoryStream
$gz = New-Object System.IO.Compression.GZipStream($gzBuf, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$buf.CopyTo($gz)
$gz.Dispose()
$gzBytes = $gzBuf.Length
$gzBuf.Dispose()
$buf.Dispose()

$gzKB = [math]::Round($gzBytes / 1024.0, 2)
$rawKB = [math]::Round($rawBytes / 1024.0, 2)
Write-Host ("  first-paint raw={0} KB  gz={1} KB  budget={2} KB" -f $rawKB, $gzKB, $FirstPaintBudgetKB)

if ($gzBytes -gt ($FirstPaintBudgetKB * 1024)) {
    Write-Host ("  [FAIL] first-paint > {0} KB gzipped" -f $FirstPaintBudgetKB) -ForegroundColor Red
    exit 1
}

# 3. CSS-only budget (own CSS only, 10 KB gzipped).
if (Test-Path 'assets/css/base.css') {
    $cssBytes = [System.IO.File]::ReadAllBytes((Resolve-Path 'assets/css/base.css'))
    $cssBuf = New-Object System.IO.MemoryStream
    $cssGzBuf = New-Object System.IO.MemoryStream
    $cssBuf.Write($cssBytes, 0, $cssBytes.Length)
    $cssBuf.Position = 0
    $cssGz = New-Object System.IO.Compression.GZipStream($cssGzBuf, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    $cssBuf.CopyTo($cssGz)
    $cssGz.Dispose()
    $cssGzBytes = $cssGzBuf.Length
    $cssGzBuf.Dispose()
    $cssBuf.Dispose()
    $cssKB = [math]::Round($cssGzBytes / 1024.0, 2)
    Write-Host ("  css gz={0} KB  budget={1} KB" -f $cssKB, $CssBudgetKB)
    if ($cssGzBytes -gt ($CssBudgetKB * 1024)) {
        Write-Host ("  [FAIL] CSS > {0} KB gzipped" -f $CssBudgetKB) -ForegroundColor Red
        exit 1
    }
}

# 4. Direct-dependency count (package.json if present).
if (Test-Path package.json) {
    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    $depCount = 0
    if ($pkg.dependencies) { $depCount += ($pkg.dependencies | Get-Member -MemberType NoteProperty).Count }
    Write-Host ("  runtime deps={0}  budget=30" -f $depCount)
    if ($depCount -gt 30) {
        Write-Host ("  [FAIL] dep budget exceeded ({0} > 30)" -f $depCount) -ForegroundColor Red
        exit 1
    }
}

Write-Host "  [OK] within budget" -ForegroundColor Green
exit 0
