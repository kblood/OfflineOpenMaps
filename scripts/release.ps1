#requires -Version 5
<#
.SYNOPSIS
  Build the OpenMaps v2 web shell and deploy it to dionysus.dk.

.DESCRIPTION
  Modeled after C:\LLM\IWSDK\release.ps1. Builds shells/web via
  `npm run build -w @openmaps/web-shell`, uploads the resulting dist/
  to a staging dir on the GCloud VM, then atomically rotates it into
  the live folder at /var/www/html/openmaps/.

  Required: OpenSSH client on PATH (Windows 10+ has it built-in), and
  an SSH key at C:\Devstuff\GCloud\caldor_nopass authorized for
  kaspersolesen@35.228.204.127.

.PARAMETER SkipBuild
  Reuse an existing shells/web/dist/ without re-running `npm run build`.
  Useful when you've already built locally and just want to redeploy.

.EXAMPLE
  .\scripts\release.ps1
  .\scripts\release.ps1 -SkipBuild
#>
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$SshKey      = 'C:\Devstuff\GCloud\caldor_nopass'
$RemoteUser  = 'kaspersolesen'
$RemoteHost  = '35.228.204.127'
$RemoteBase  = '/var/www/html'
$RemoteName  = 'openmaps'
$Root        = Split-Path -Parent $PSScriptRoot
$WebShellDir = Join-Path $Root 'shells\web'
$DistDir     = Join-Path $WebShellDir 'dist'
$Htaccess    = Join-Path $Root 'deploy\.htaccess'
$Target      = "${RemoteUser}@${RemoteHost}"

if (-not (Test-Path "$WebShellDir\package.json")) {
  throw "Web shell not found at $WebShellDir"
}
if (-not (Test-Path $SshKey)) {
  throw "SSH key missing: $SshKey"
}

$SshOpts = @(
  '-i', $SshKey,
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new'
)

function Invoke-Ssh([string]$RemoteCommand) {
  & ssh @SshOpts $Target $RemoteCommand
  if ($LASTEXITCODE -ne 0) { throw "ssh failed: $RemoteCommand" }
}

function Invoke-Scp([string]$Source, [string]$Destination) {
  & scp @SshOpts -r $Source "${Target}:${Destination}"
  if ($LASTEXITCODE -ne 0) { throw "scp failed: $Source -> $Destination" }
}

if (-not $SkipBuild) {
  Write-Host ""
  Write-Host "=== Building @openmaps/web-shell ===" -ForegroundColor Cyan
  Push-Location $Root
  try {
    # Call npm without `&` — the PowerShell 7 call operator hits a
    # known npm.cmd shim bug that drops the first character of the args.
    npm run build -w '@openmaps/web-shell'
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $DistDir)) {
  throw "Build produced no dist/ at $DistDir (re-run without -SkipBuild)"
}

$StagingId   = ([guid]::NewGuid().ToString().Substring(0, 8))
$StagingPath = "${RemoteBase}/.staging-${RemoteName}-${StagingId}"
$LivePath    = "${RemoteBase}/${RemoteName}"
$OldPath     = "${LivePath}.old-${StagingId}"

Write-Host ""
Write-Host "=== Preparing staging on $RemoteHost ===" -ForegroundColor Cyan
Write-Host "    $StagingPath"
Invoke-Ssh "mkdir -p '$StagingPath' && mkdir -p '$RemoteBase'"

Write-Host ""
Write-Host "=== Uploading dist/ ===" -ForegroundColor Cyan
Get-ChildItem -Path $DistDir -Force | ForEach-Object {
  Write-Host "    + $($_.Name)"
  Invoke-Scp $_.FullName "$StagingPath/"
}

if (Test-Path $Htaccess) {
  Write-Host "    + .htaccess"
  Invoke-Scp $Htaccess "$StagingPath/.htaccess"
} else {
  Write-Warning "deploy\.htaccess missing — skipping cache/MIME config upload"
}

Write-Host ""
Write-Host "=== Atomic swap to live path ===" -ForegroundColor Cyan
# Move the existing live folder aside first (if present), promote the
# staging folder, then delete the displaced one. The intermediate state
# is at most a few ms long and never leaves a half-uploaded site live.
#
# IMPORTANT: the `packs/` subfolder is managed by scripts/publish-packs.ps1
# (separate cadence — region rebuilds happen independently of web-shell
# releases). If a packs/ folder exists in the live tree, move it into the
# new staging *before* the swap so a web-shell deploy never wipes the
# pack catalog. Without this, the old folder is rm -rf'd along with its
# packs and users see 404s until publish-packs.ps1 is re-run.
$preservePacks =
  "if [ -d '$LivePath/packs' ]; then mv '$LivePath/packs' '$StagingPath/packs'; fi"
$swap = "if [ -e '$LivePath' ]; then mv '$LivePath' '$OldPath'; fi && " +
        "mv '$StagingPath' '$LivePath' && " +
        "rm -rf '$OldPath'"
Invoke-Ssh "$preservePacks && $swap"

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Live: https://dionysus.dk/${RemoteName}/" -ForegroundColor Green
