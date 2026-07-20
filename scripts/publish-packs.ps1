#requires -Version 5
<#
.SYNOPSIS
  Publish region packs from a local directory to dionysus.dk/openmaps/packs/.

.DESCRIPTION
  Walks $PacksDir for pack subfolders (each must contain manifest.json,
  tiles.mbtiles + geocode.sqlite, or one schema-v2 openmaps.sqlite). For each one:
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
  [string]$OnlyPack = '',
  [string]$CollectionsDir = '',
  [string]$RoutingDir = '',
  [switch]$SkipPacks,
  [switch]$SkipRouting
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
if (-not $CollectionsDir) {
  $CollectionsDir = Join-Path $Root 'config'
}
if (-not $RoutingDir) {
  $RoutingDir = Join-Path $Root 'routing'
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
  '-o', 'StrictHostKeyChecking=accept-new',
  # A stalled SSH command used to leave the resumable country builder waiting
  # forever at an otherwise atomic rename. Bound both connection setup and an
  # unresponsive established session so a rerun can safely resume.
  '-o', 'ConnectTimeout=20',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4'
)

function Invoke-Ssh([string]$RemoteCommand) {
  & ssh @SshOpts $Target $RemoteCommand
  if ($LASTEXITCODE -ne 0) { throw "ssh failed: $RemoteCommand" }
}

function Invoke-Scp([string]$Source, [string]$Destination) {
  & scp @SshOpts -r $Source "${Target}:${Destination}"
  if ($LASTEXITCODE -ne 0) { throw "scp failed: $Source -> $Destination" }
}

# Enumerate pack subfolders. A valid legacy pack has manifest.json,
# tiles.mbtiles and geocode.sqlite; a schema-v2 unified pack has
# manifest.json and openmaps.sqlite. Anything else is skipped with a warning.
$packs = @()
Get-ChildItem -Path $PacksDir -Directory | ForEach-Object {
  $dir = $_.FullName
  $manifestPath = Join-Path $dir 'manifest.json'
  $tilesPath    = Join-Path $dir 'tiles.mbtiles'
  $geocodePath  = Join-Path $dir 'geocode.sqlite'
  $databasePath = Join-Path $dir 'openmaps.sqlite'
  if (-not (Test-Path $manifestPath)) {
    Write-Warning "Skipping $($_.Name): missing manifest.json"
    return
  }
  $manifestRaw = Get-Content $manifestPath -Raw
  $manifest = $manifestRaw | ConvertFrom-Json
  $isUnified = [int]$manifest.schemaVersion -eq 2
  if ($isUnified -and -not (Test-Path $databasePath)) {
    Write-Warning "Skipping $($_.Name): schema-v2 manifest is missing openmaps.sqlite"
    return
  }
  if (-not $isUnified -and (-not (Test-Path $tilesPath) -or -not (Test-Path $geocodePath))) {
    Write-Warning "Skipping $($_.Name): missing manifest/tiles/geocode"
    return
  }
  $totalBytes =
    (Get-Item $manifestPath).Length +
    $(if ($isUnified) { (Get-Item $databasePath).Length } else { (Get-Item $tilesPath).Length + (Get-Item $geocodePath).Length })

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

# A collection is published only when every referenced region is a valid
# local pack. This prevents a country entry from advertising incomplete
# coverage while a multi-region build is still in progress.
$collections = @()
if (Test-Path $CollectionsDir) {
  Get-ChildItem -Path $CollectionsDir -Filter '*-collection.json' -File | ForEach-Object {
    $raw = Get-Content $_.FullName -Raw
    $collection = $raw | ConvertFrom-Json
    $members = @($collection.members | ForEach-Object { [string]$_ })
    $missing = @($members | Where-Object { $_ -notin @($packs | ForEach-Object { $_.id }) })
    if ($missing.Count -gt 0) {
      Write-Warning "Skipping collection $($collection.id): missing valid packs $($missing -join ', ')"
      return
    }
    $collections += [PSCustomObject]@{
      id          = [string]$collection.id
      name        = [string]$collection.name
      country     = [string]$collection.country
      bbox        = $collection.bbox
      description = [string]$collection.description
      members     = $members
    }
  }
}

# National routing companions are deliberately separate from map packs. They
# are uploaded under packs/routing/ and advertised in the same atomic catalog,
# allowing the web shell to download and checksum-verify them independently.
$routingBundles = @()
if (Test-Path $RoutingDir) {
  Get-ChildItem -Path $RoutingDir -Filter '*.json' -File | ForEach-Object {
    $descriptorPath = $_.FullName
    $descriptor = (Get-Content $descriptorPath -Raw | ConvertFrom-Json)
    $fileName = [string]$descriptor.file.path
    $sqlitePath = Join-Path $RoutingDir $fileName
    if (-not $descriptor.id -or -not $fileName -or -not (Test-Path $sqlitePath)) {
      Write-Warning "Skipping routing descriptor $($_.Name): missing id or database file"
      return
    }
    $actualBytes = (Get-Item $sqlitePath).Length
    if ($actualBytes -ne [int64]$descriptor.file.bytes) {
      throw "Routing companion $($descriptor.id) size mismatch: descriptor=$($descriptor.file.bytes), actual=$actualBytes"
    }
    $routingBundles += [PSCustomObject]@{
      id          = [string]$descriptor.id
      name        = [string]$descriptor.name
      country     = [string]$descriptor.country
      bbox        = $descriptor.bbox
      baseUrl     = 'routing/'
      file        = $descriptor.file
      profiles    = @($descriptor.profiles)
      description = [string]$descriptor.description
      _descriptor = $descriptorPath
      _database   = $sqlitePath
    }
  }
}

# Ensure the remote root exists.
Invoke-Ssh "mkdir -p '$RemoteBase'"

foreach ($bundle in $routingBundles) {
  if ($SkipRouting) {
    Write-Host "Skipping routing companion $($bundle.id) (-SkipRouting)" -ForegroundColor DarkGray
    continue
  }
  Write-Host ""
  Write-Host "=== Uploading routing companion $($bundle.id) ($([Math]::Round($bundle.file.bytes / 1MB, 1)) MB) ===" -ForegroundColor Cyan
  $routingStaging = "$RemoteBase/.staging-routing-$($bundle.id)-$([guid]::NewGuid().ToString().Substring(0, 8))"
  $routingLive = "$RemoteBase/routing"
  $routingOld = "$routingLive.old-$([guid]::NewGuid().ToString().Substring(0, 8))"
  Invoke-Ssh "mkdir -p '$routingStaging'"
  Invoke-Scp $bundle._descriptor "$routingStaging/$([IO.Path]::GetFileName($bundle._descriptor))"
  Invoke-Scp $bundle._database "$routingStaging/$([IO.Path]::GetFileName($bundle._database))"
  $routingSwap = "if [ -e '$routingLive' ]; then mv '$routingLive' '$routingOld'; fi && " +
                 "mv '$routingStaging' '$routingLive' && rm -rf '$routingOld'"
  Invoke-Ssh $routingSwap
}

# Upload pack folders.
foreach ($p in $packs) {
  if ($SkipPacks) {
    Write-Host "Skipping $($p.id) (-SkipPacks)" -ForegroundColor DarkGray
    continue
  }
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
  collections = $collections
  routingBundles = @($routingBundles | ForEach-Object {
    [PSCustomObject]@{
      id          = $_.id
      name        = $_.name
      country     = $_.country
      bbox        = $_.bbox
      baseUrl     = $_.baseUrl
      file        = $_.file
      profiles    = $_.profiles
      description = $_.description
    }
  })
}
$indexJson = $indexObj | ConvertTo-Json -Depth 6
$tempIndex = New-TemporaryFile
Set-Content -Path $tempIndex.FullName -Value $indexJson -Encoding utf8 -NoNewline

Write-Host ""
Write-Host "=== Uploading packs.json ===" -ForegroundColor Cyan
$indexTmp = "$RemoteBase/packs.json.tmp"
$indexFinal = "$RemoteBase/packs.json"
Invoke-Scp $tempIndex.FullName $indexTmp
# The catalogue is a single small file; a healthy rename is instantaneous.
# Bound it so a remote filesystem stall cannot strand the resumable builder.
Invoke-Ssh "timeout 30s mv '$indexTmp' '$indexFinal'"
Remove-Item $tempIndex -Force

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Catalog: https://dionysus.dk/openmaps/packs/packs.json" -ForegroundColor Green
foreach ($p in $indexObj.packs) {
  Write-Host "  - $($p.name) ($($p.id)) — $([Math]::Round($p.totalBytes / 1MB, 1)) MB" -ForegroundColor Green
}
foreach ($collection in $indexObj.collections) {
  Write-Host "  - $($collection.name) collection ($($collection.members.Count) regions)" -ForegroundColor Green
}
