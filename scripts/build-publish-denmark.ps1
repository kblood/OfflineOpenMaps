#requires -Version 7
<#
.SYNOPSIS
  Resumable Denmark regional-pack production runner.

.DESCRIPTION
  For each requested region it builds the bounded PBF pack, verifies file
  hashes and the complete offline contract, then publishes that one region.
  Existing valid packs are skipped, so the command is safe to restart after a
  power or network interruption.
#>
param(
  [string]$Pbf = '',
  [string]$Only = '',
  [switch]$NoPublish,
  [switch]$Rebuild,
  [switch]$PublishExisting
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Pbf) { $Pbf = Join-Path $Root 'data/denmark-latest.osm.pbf' }
if (-not (Test-Path $Pbf)) { throw "Denmark PBF not found: $Pbf" }

$collection = Get-Content (Join-Path $Root 'config/denmark-collection.json') -Raw | ConvertFrom-Json
$ids = @($collection.members | ForEach-Object { [string]$_ })
if ($Only) {
  if ($Only -notin $ids) { throw "Unknown Denmark region: $Only" }
  $ids = @($Only)
}

foreach ($id in $ids) {
  $packDir = Join-Path $Root "packs/$id"
  $valid = $false
  $builtThisRun = $false
  if (-not $Rebuild -and (Test-Path (Join-Path $packDir 'manifest.json'))) {
    & node (Join-Path $Root 'scripts/verify-pack.mjs') $id
    $valid = $LASTEXITCODE -eq 0
  }
  if (-not $valid) {
    Write-Host "`n=== Building $id ===" -ForegroundColor Cyan
    & node (Join-Path $Root 'scripts/build-denmark-regions.mjs') --pbf $Pbf --only $id
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $id" }
    & node (Join-Path $Root 'scripts/verify-pack.mjs') $id
    if ($LASTEXITCODE -ne 0) { throw "Verification failed: $id" }
    $builtThisRun = $true
  } else {
    Write-Host "`n=== Reusing verified $id ===" -ForegroundColor DarkGreen
  }
  # Every fresh build is published immediately. Reused verified packs were
  # published by an earlier successful iteration, so leave them alone unless
  # an explicit recovery upload is requested.
  if (-not $NoPublish -and ($builtThisRun -or $PublishExisting)) {
    & pwsh -NoProfile -File (Join-Path $Root 'scripts/publish-packs.ps1') -OnlyPack $id
    if ($LASTEXITCODE -ne 0) { throw "Publish failed: $id" }
  }
}
