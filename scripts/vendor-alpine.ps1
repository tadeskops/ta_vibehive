#requires -Version 5.1
<#
.SYNOPSIS
    Reproducibly vendor Alpine.js under assets/vendor/.

.DESCRIPTION
    Downloads Alpine.js pinned version + verifies SHA-384 against the recorded
    hash in assets/vendor/HASHES.md. Fails hard on hash mismatch.

    Alpine.js is our only shipped runtime dependency (see docs/deps.md). It's
    tiny (~15 KB gzipped) and gives us x-data reactivity for HTMX-style islands
    without a build step. Vendored so CSP script-src can stay 'self'.
#>
[CmdletBinding()]
param(
    [string]$Version = '3.14.1',
    [string]$ExpectedSha384 = 'l8f0VcPi/M1iHPv8egOnY/15TDwqgbOR1anMIJWvU6nLRgZVLTLSaNqi/TOoT5Fh'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'assets\vendor'
$dst = Join-Path $vendor "alpine-$Version.min.js"

New-Item -ItemType Directory -Force -Path $vendor | Out-Null

$url = "https://cdn.jsdelivr.net/npm/alpinejs@$Version/dist/cdn.min.js"
Write-Host "Fetching $url" -ForegroundColor Cyan

Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing

$bytes = [System.IO.File]::ReadAllBytes($dst)
$sha384 = [System.Security.Cryptography.SHA384]::Create()
$hash = [Convert]::ToBase64String($sha384.ComputeHash($bytes))
Write-Host ("computed sha384-{0}" -f $hash) -ForegroundColor Yellow

if ($ExpectedSha384 -and $hash -ne $ExpectedSha384) {
    Write-Host "[FAIL] hash mismatch" -ForegroundColor Red
    Write-Host "  expected sha384-$ExpectedSha384"
    Write-Host "  got      sha384-$hash"
    Remove-Item -LiteralPath $dst
    exit 1
}

$size = (Get-Item $dst).Length
Write-Host ("[OK] vendored {0}  ({1} bytes  sha384-{2})" -f $dst, $size, $hash) -ForegroundColor Green
Write-Host "Update assets/vendor/HASHES.md if this is a new version."
