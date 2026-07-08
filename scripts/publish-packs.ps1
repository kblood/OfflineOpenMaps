#requires -Version 5
<#
.SYNOPSIS
  Publish region packs from a local directory to dionysus.dk/openmaps/packs/.

.DESCRIPTION
  Walks $PacksDir for pack subfolders (each must contain manifest.json,
  tiles.mbtiles, and geocode.sqlite). For each one:
    1. scp the folder to /var/www/html/openmaps/packs/<id>/
    2. Build a packs.json index combining every pack's metadata.
    3. scp packs.json LAST (atomically, via tmp + mv) so the web shell
       never sees a half-uploaded pack in the catalog.

  The web shell at https://dionysus.dk/openmaps/ fetches
  ./packs/packs.json on load and offers each pack as a download button.

.PARAMETER PacksDir
  Directory containing the pack subfolders. Defaults to
  openmaps-v2/packs (where the CLI writes by default).

.PARAMETER OnlyPack
  If set, publishes only the named pack id rather than all packs in
  PacksDir. The packs.json index is still regenerated from all packs.

.EXAMPLE
  .\scripts\publish-packs.ps1
  .\scripts\publish-packs.ps1 -OnlyPack aalborg
#>
param(
  [string]$PacksDir = '',
  [string]$OnlyPack = ''
)

$ErrorActionPreference = 'Stop'

$SshKey      = 'C:\Devstuff\GCloud\caldor_nopass'
$RemoteUser  = 'kaspersolesen'
$RemoteHost  = '35.228.204.127'
$RemoteBase  = '/var/www/html/openmaps/packs'
$Root        = Split-Path -Parent $PSScriptRoot
if (-not $PacksDir) {
  $PacksDir = Join-Path $Root 'packs'
}
$Target = "${RemoteUser}@${RemoteHost}"

if (-not (Test-Path $PacksDir)) {
  throw "Packs directory not found: $PacksDir"
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

# Enumerate pack subfolders. A valid pack folder has all three of
# manifest.json, tiles.mbtiles, geocode.sqlite. Anything else is
# skipped with a warning rather than failing the whole publish.
$packs = @()
Get-ChildItem -Path $PacksDir -Directory | ForEach-Object {
  $dir = $_.FullName
  $manifestPath = Join-Path $dir 'manifest.json'
  $tilesPath    = Join-Path $dir 'tiles.mbtiles'
  $geocodePath  = Join-Path $dir 'geocode.sqlite'
  if (-not (Test-Path $manifestPath) -or -not (Test-Path $tilesPath) -or -not (Test-Path $geocodePath)) {
    Write-Warning "Skipping $($_.Name): missing manifest/tiles/geocode"
    return
  }
  $manifestRaw = Get-Content $manifestPath -Raw
  $manifest = $manifestRaw | ConvertFrom-Json
  $totalBytes =
    (Get-Item $manifestPath).Length +
    (Get-Item $tilesPath).Length +
    (Get-Item $geocodePath).Length

  # ConvertFrom-Json deserializes ISO 8601 strings into [DateTime] in
  # local time and ConvertTo-Json then emits them with locale formatting
  # ("05/19/2026 08:13:25") which isn't a valid timestamp anywhere. Pull
  # builtAt back out of the raw JSON text so the round-trip preserves
  # the original ISO string exactly.
  $builtAt = if ($manifestRaw -match '"builtAt"\s*:\s*"([^"]+)"') { $matches[1] } else { '' }

  $packs += [PSCustomObject]@{
    id         = [string]$manifest.id
    name       = [string]$manifest.name
    country    = [string]$manifest.country
    bbox       = $manifest.bbox
    builtAt    = $builtAt
    totalBytes = [int64]$totalBytes
    baseUrl    = "$([string]$manifest.id)/"
    _dir       = $dir
    _name      = $_.Name
  }
}

if ($packs.Count -eq 0) {
  throw "No valid packs found in $PacksDir"
}

# Ensure the remote root exists.
Invoke-Ssh "mkdir -p '$RemoteBase'"

# Upload pack folders.
foreach ($p in $packs) {
  if ($OnlyPack -and $p.id -ne $OnlyPack -and $p._name -ne $OnlyPack) {
    Write-Host "Skipping $($p.id) (only publishing $OnlyPack)" -ForegroundColor DarkGray
    continue
  }
  Write-Host ""
  Write-Host "=== Uploading $($p.id) ($([Math]::Round($p.totalBytes / 1MB, 1)) MB) ===" -ForegroundColor Cyan
  # Staging-then-rename per pack: write to .staging-<id>-<rand>, then
  # atomically swap into place. Avoids leaving a torn pack live if scp
  # gets interrupted mid-upload.
  $rand = ([guid]::NewGuid().ToString().Substring(0, 8))
  $stagingPath = "$RemoteBase/.staging-$($p.id)-$rand"
  $livePath    = "$RemoteBase/$($p.id)"
  $oldPath     = "$livePath.old-$rand"

  Invoke-Ssh "mkdir -p '$stagingPath'"
  Get-ChildItem -Path $p._dir -File | ForEach-Object {
    Write-Host "    + $($_.Name)"
    Invoke-Scp $_.FullName "$stagingPath/"
  }
  $swap = "if [ -e '$livePath' ]; then mv '$livePath' '$oldPath'; fi && " +
          "mv '$stagingPath' '$livePath' && " +
          "rm -rf '$oldPath'"
  Invoke-Ssh $swap
}

# Build and upload the index. We always regenerate from ALL packs in
# the local PacksDir, so removing a pack folder locally and re-running
# this script effectively retires it from the catalog (the orphaned
# server folder is left in place — a sysadmin can rm it).
$indexObj = [PSCustomObject]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  packs       = $packs | ForEach-Object {
    [PSCustomObject]@{
      id         = $_.id
      name       = $_.name
      country    = $_.country
      bbox       = $_.bbox
      builtAt    = $_.builtAt
      totalBytes = $_.totalBytes
      baseUrl    = $_.baseUrl
    }
  }
}
$indexJson = $indexObj | ConvertTo-Json -Depth 6
$tempIndex = New-TemporaryFile
Set-Content -Path $tempIndex.FullName -Value $indexJson -Encoding utf8 -NoNewline

Write-Host ""
Write-Host "=== Uploading packs.json ===" -ForegroundColor Cyan
$indexTmp = "$RemoteBase/packs.json.tmp"
$indexFinal = "$RemoteBase/packs.json"
Invoke-Scp $tempIndex.FullName $indexTmp
Invoke-Ssh "mv '$indexTmp' '$indexFinal'"
Remove-Item $tempIndex -Force

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Catalog: https://dionysus.dk/openmaps/packs/packs.json" -ForegroundColor Green
foreach ($p in $indexObj.packs) {
  Write-Host "  - $($p.name) ($($p.id)) — $([Math]::Round($p.totalBytes / 1MB, 1)) MB" -ForegroundColor Green
}
