#requires -Version 7
<#
.SYNOPSIS
  Publish region packs from a local directory to dionysus.dk/openmaps/packs/.

.DESCRIPTION
  Walks $PacksDir for pack subfolders (each must contain manifest.json,
  tiles.mbtiles + geocode.sqlite, or one schema-v2 openmaps.sqlite). For each one:
    1. Resume each data file into a content-addressed staging folder with SFTP.
    2. Verify remote byte counts and SHA-256 hashes, then atomically promote it.
    3. Build a packs.json index combining every pack's metadata.
    4. Upload packs.json LAST (atomically, via tmp + mv) so the web shell
       never sees a half-uploaded pack in the catalog.

  The web shell at https://dionysus.dk/openmaps/ fetches
  ./packs/packs.json on load and offers each pack as a download button.

.PARAMETER PacksDir
  Directory containing the pack subfolders. Defaults to
  openmaps-v2/packs (where the CLI writes by default).

.PARAMETER OnlyPack
  If set, publishes only the named pack id rather than all packs in
  PacksDir. The packs.json index is still regenerated from all packs, and
  routing companions are skipped unless -PublishRouting is also supplied.

.PARAMETER DryRun
  Validate manifests, referenced files, selection, and the generated catalog
  without connecting to the server.

.PARAMETER PreflightOnly
  Run local validation plus a bounded SSH connection/directory check, then exit
  without uploading or changing the catalog.

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
  [switch]$SkipRouting,
  [switch]$PublishRouting,
  [switch]$DryRun,
  [switch]$PreflightOnly,
  [ValidateRange(10, 3600)][int]$SshCommandTimeoutSeconds = 120,
  [ValidateRange(60, 86400)][int]$TransferTimeoutSeconds = 21600,
  [ValidateRange(60, 7200)][int]$VerifyTimeoutSeconds = 1800
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
if (-not $DryRun -and -not (Test-Path $SshKey)) {
  throw "SSH key missing: $SshKey"
}
if ($SkipRouting -and $PublishRouting) {
  throw '-SkipRouting and -PublishRouting cannot be used together'
}
if ($DryRun -and $PreflightOnly) {
  throw '-DryRun and -PreflightOnly cannot be used together'
}

$SshOpts = @(
  '-i', $SshKey,
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  # A stalled SSH command used to leave the resumable country builder waiting
  # forever at an otherwise atomic rename. Bound both connection setup and an
  # unresponsive established session so a rerun can safely resume.
  '-o', 'ConnectTimeout=20',
  '-o', 'ConnectionAttempts=1',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4'
)

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][int]$TimeoutSeconds,
    [Parameter(Mandatory)][string]$Description
  )
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.UseShellExecute = $false
  foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "could not start $Executable" }
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { $process.Kill($true) } catch { }
      throw "$Description timed out after $TimeoutSeconds seconds"
    }
    if ($process.ExitCode -ne 0) {
      throw "$Description failed with exit code $($process.ExitCode)"
    }
  } finally {
    $process.Dispose()
  }
}

function ConvertTo-ShellLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "'`"'`"'") + "'"
}

function Invoke-Ssh {
  param(
    [Parameter(Mandatory)][string]$RemoteCommand,
    [int]$TimeoutSeconds = $SshCommandTimeoutSeconds
  )
  # ServerAlive detects a dead connection, but not a live SSH server whose
  # command never completes. Apply both a remote and local wall-clock bound.
  $bounded = "timeout --signal=TERM --kill-after=10s ${TimeoutSeconds}s sh -c $(ConvertTo-ShellLiteral $RemoteCommand)"
  Invoke-NativeCommand -Executable 'ssh' -Arguments @($SshOpts + @($Target, $bounded)) `
    -TimeoutSeconds ($TimeoutSeconds + 30) -Description "ssh command"
}

function ConvertTo-SftpPath([string]$Path) {
  if ($Path.Contains('"')) { throw "SFTP paths containing a double quote are unsupported: $Path" }
  return '"' + $Path.Replace('\', '/') + '"'
}

function Invoke-SftpUpload {
  param(
    [Parameter(Mandatory)][string]$LocalPath,
    [Parameter(Mandatory)][string]$RemotePath,
    [switch]$Resume
  )
  $batch = New-TemporaryFile
  try {
    # OpenSSH's `reput` resumes an existing remote file but, unlike `put`,
    # fails when the destination does not exist. Seed a zero-byte staging file
    # for the first attempt; retries keep the already-uploaded prefix intact.
    if ($Resume) {
      $quotedRemotePath = ConvertTo-ShellLiteral $RemotePath
      Invoke-Ssh -RemoteCommand "test -e $quotedRemotePath || : > $quotedRemotePath"
    }
    $verb = if ($Resume) { 'reput' } else { 'put' }
    Set-Content -LiteralPath $batch.FullName -Encoding utf8 -NoNewline `
      -Value "$verb $(ConvertTo-SftpPath $LocalPath) $(ConvertTo-SftpPath $RemotePath)`n"
    Invoke-NativeCommand -Executable 'sftp' -Arguments @($SshOpts + @('-b', $batch.FullName, $Target)) `
      -TimeoutSeconds $TransferTimeoutSeconds -Description "SFTP upload $LocalPath"
  } finally {
    Remove-Item -LiteralPath $batch.FullName -Force -ErrorAction SilentlyContinue
  }
}

function Assert-SafeName([string]$Value, [string]$Description) {
  if ($Value -notmatch '^[A-Za-z0-9._-]+$' -or $Value -in '.', '..') {
    throw "$Description contains unsafe characters: $Value"
  }
}

function Get-PackFileSpec($Descriptor, [string]$PackDir, [string]$Description) {
  if (-not $Descriptor) { throw "$Description is missing from manifest" }
  $name = [string]$Descriptor.path
  Assert-SafeName $name "$Description path"
  $localPath = Join-Path $PackDir $name
  if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) { throw "$Description file is missing: $localPath" }
  $actualBytes = (Get-Item -LiteralPath $localPath).Length
  if ($actualBytes -ne [int64]$Descriptor.bytes) {
    throw "$Description size mismatch: manifest=$($Descriptor.bytes), local=$actualBytes"
  }
  $hash = [string]$Descriptor.sha256
  if ($hash -notmatch '^[0-9a-f]{64}$') { throw "$Description has an invalid SHA-256" }
  return [PSCustomObject]@{ name = $name; path = $localPath; bytes = [int64]$actualBytes; sha256 = $hash }
}

function Assert-LocalHash($FileSpec, [string]$Description) {
  $actual = (Get-FileHash -LiteralPath $FileSpec.path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $FileSpec.sha256) { throw "$Description SHA-256 mismatch" }
}

function Assert-RemoteFile($FileSpec, [string]$RemotePath) {
  $quotedPath = ConvertTo-ShellLiteral $RemotePath
  $command = "test `$(stat -c %s $quotedPath) -eq $($FileSpec.bytes) && " +
             "test `$(sha256sum $quotedPath | cut -d ' ' -f1) = '$($FileSpec.sha256)'"
  Invoke-Ssh -RemoteCommand $command -TimeoutSeconds $VerifyTimeoutSeconds
}

# Enumerate pack subfolders. A valid legacy pack has manifest.json,
# tiles.mbtiles and geocode.sqlite; a schema-v2 unified pack has
# manifest.json and openmaps.sqlite. Anything else is skipped with a warning.
$packs = @()
Get-ChildItem -Path $PacksDir -Directory | ForEach-Object {
  $dir = $_.FullName
  $manifestPath = Join-Path $dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Write-Warning "Skipping $($_.Name): missing manifest.json"
    return
  }
  $manifestRaw = Get-Content -LiteralPath $manifestPath -Raw
  $manifest = $manifestRaw | ConvertFrom-Json
  if ([int]$manifest.schemaVersion -notin 1, 2) {
    throw "Pack $($_.Name) has unsupported schemaVersion $($manifest.schemaVersion)"
  }
  Assert-SafeName ([string]$manifest.id) "Pack id"
  $isUnified = [int]$manifest.schemaVersion -eq 2

  # Upload only files referenced by the manifest. Alias entries in schema v2
  # and shared geocode/routing files in schema v1 are de-duplicated by path.
  $descriptors = if ($isUnified) {
    @($manifest.files.database)
  } else {
    @($manifest.files.tiles, $manifest.files.geocode, $manifest.files.routing)
  }
  $fileSpecsByName = @{}
  foreach ($descriptor in $descriptors) {
    $spec = Get-PackFileSpec $descriptor $dir "Pack $($manifest.id) file"
    if ($fileSpecsByName.ContainsKey($spec.name)) {
      $existing = $fileSpecsByName[$spec.name]
      if ($existing.bytes -ne $spec.bytes -or $existing.sha256 -ne $spec.sha256) {
        throw "Pack $($manifest.id) contains conflicting descriptors for $($spec.name)"
      }
    } else {
      $fileSpecsByName[$spec.name] = $spec
    }
  }
  $fileSpecs = @($fileSpecsByName.Values | Sort-Object name)
  $totalBytes = (Get-Item -LiteralPath $manifestPath).Length +
                (($fileSpecs | Measure-Object -Property bytes -Sum).Sum)

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
    _manifest  = $manifestPath
    _manifestSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    _files     = $fileSpecs
  }
}

if ($packs.Count -eq 0) {
  throw "No valid packs found in $PacksDir"
}
if ($OnlyPack -and -not ($packs | Where-Object { $_.id -eq $OnlyPack -or $_._name -eq $OnlyPack })) {
  throw "Requested pack was not found or invalid: $OnlyPack"
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
    if (-not $descriptor.id -or -not $fileName) { throw "Routing descriptor $($_.Name) is missing id or database path" }
    Assert-SafeName ([string]$descriptor.id) "Routing bundle id"
    Assert-SafeName $_.Name "Routing descriptor filename"
    $fileSpec = Get-PackFileSpec $descriptor.file $RoutingDir "Routing companion $($descriptor.id)"
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
      _descriptorName = $_.Name
      _fileSpec   = $fileSpec
    }
  }
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

$selectedPacks = @($packs | Where-Object {
  -not $SkipPacks -and (-not $OnlyPack -or $_.id -eq $OnlyPack -or $_._name -eq $OnlyPack)
})
# Publishing one map should not silently spend time and bandwidth republishing
# an unchanged national routing database. Opt in with -PublishRouting.
$uploadRouting = -not $SkipRouting -and (-not $OnlyPack -or $PublishRouting)

if ($DryRun) {
  Write-Host "Dry run passed." -ForegroundColor Green
  Write-Host "  Catalog packs: $($packs.Count)"
  Write-Host "  Packs selected for upload: $($selectedPacks.id -join ', ')"
  Write-Host "  Routing bundles selected for upload: $(if ($uploadRouting) { $routingBundles.id -join ', ' } else { '(none)' })"
  Write-Host "  Catalog bytes: $([Text.Encoding]::UTF8.GetByteCount($indexJson))"
  exit 0
}

# Ensure the remote root exists. This preflight is locally and remotely
# bounded; it replaces the indefinite wait that stranded the prior upload.
Invoke-Ssh -RemoteCommand "mkdir -p '$RemoteBase'"
if ($PreflightOnly) {
  Write-Host "Remote preflight passed; no files were uploaded." -ForegroundColor Green
  exit 0
}

if ($uploadRouting -and $routingBundles.Count -gt 0) {
  $identityText = ($routingBundles | Sort-Object id | ForEach-Object { "$($_.id):$($_._fileSpec.sha256)" }) -join '|'
  $identityBytes = [Text.Encoding]::UTF8.GetBytes($identityText)
  $routingToken = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($identityBytes)).ToLowerInvariant().Substring(0, 16)
  $routingStaging = "$RemoteBase/.staging-routing-$routingToken"
  $routingLive = "$RemoteBase/routing"
  $routingOld = "$routingLive.old-$([guid]::NewGuid().ToString().Substring(0, 8))"
  Invoke-Ssh -RemoteCommand "mkdir -p '$routingStaging'"
  foreach ($bundle in $routingBundles) {
    Write-Host ""
    Write-Host "=== Uploading routing companion $($bundle.id) ($([Math]::Round($bundle.file.bytes / 1MB, 1)) MB) ===" -ForegroundColor Cyan
    Assert-LocalHash $bundle._fileSpec "Routing companion $($bundle.id)"
    Write-Host "    + $($bundle._fileSpec.name) (resumable)"
    Invoke-SftpUpload -LocalPath $bundle._fileSpec.path -RemotePath "$routingStaging/$($bundle._fileSpec.name)" -Resume
    Assert-RemoteFile $bundle._fileSpec "$routingStaging/$($bundle._fileSpec.name)"
    Write-Host "    + $($bundle._descriptorName)"
    Invoke-SftpUpload -LocalPath $bundle._descriptor -RemotePath "$routingStaging/$($bundle._descriptorName)"
  }
  $routingSwap = "if [ -e '$routingLive' ]; then mv '$routingLive' '$routingOld'; fi; " +
                 "if mv '$routingStaging' '$routingLive'; then exit 0; fi; " +
                 "if [ -e '$routingOld' ]; then mv '$routingOld' '$routingLive'; fi; exit 1"
  Invoke-Ssh -RemoteCommand $routingSwap
  try { Invoke-Ssh -RemoteCommand "rm -rf '$routingOld'" } catch { Write-Warning "Routing is live, but old-folder cleanup failed: $_" }
}

foreach ($p in $selectedPacks) {
  Write-Host ""
  Write-Host "=== Uploading $($p.id) ($([Math]::Round($p.totalBytes / 1MB, 1)) MB) ===" -ForegroundColor Cyan
  $token = $p._manifestSha.Substring(0, 16)
  # Content-addressed staging makes a retry resume the same partial upload;
  # a rebuilt pack gets a different staging directory and cannot be mixed.
  $stagingPath = "$RemoteBase/.staging-$($p.id)-$token"
  $livePath = "$RemoteBase/$($p.id)"
  $oldPath = "$livePath.old-$([guid]::NewGuid().ToString().Substring(0, 8))"
  Invoke-Ssh -RemoteCommand "mkdir -p '$stagingPath'"

  foreach ($fileSpec in $p._files) {
    Assert-LocalHash $fileSpec "Pack $($p.id) file $($fileSpec.name)"
    Write-Host "    + $($fileSpec.name) (resumable)"
    Invoke-SftpUpload -LocalPath $fileSpec.path -RemotePath "$stagingPath/$($fileSpec.name)" -Resume
    Write-Host "      verifying remote size and SHA-256"
    Assert-RemoteFile $fileSpec "$stagingPath/$($fileSpec.name)"
  }

  # Manifest is small and goes last so even staging is internally coherent.
  Write-Host "    + manifest.json"
  Invoke-SftpUpload -LocalPath $p._manifest -RemotePath "$stagingPath/manifest.json"
  $manifestSpec = [PSCustomObject]@{
    bytes = (Get-Item -LiteralPath $p._manifest).Length
    sha256 = $p._manifestSha
  }
  Assert-RemoteFile $manifestSpec "$stagingPath/manifest.json"

  $swap = "if [ -e '$livePath' ]; then mv '$livePath' '$oldPath'; fi; " +
          "if mv '$stagingPath' '$livePath'; then exit 0; fi; " +
          "if [ -e '$oldPath' ]; then mv '$oldPath' '$livePath'; fi; exit 1"
  Invoke-Ssh -RemoteCommand $swap
  try { Invoke-Ssh -RemoteCommand "rm -rf '$oldPath'" } catch { Write-Warning "$($p.id) is live, but old-folder cleanup failed: $_" }
}

$tempIndex = New-TemporaryFile
Set-Content -LiteralPath $tempIndex.FullName -Value $indexJson -Encoding utf8 -NoNewline

Write-Host ""
Write-Host "=== Uploading packs.json ===" -ForegroundColor Cyan
$indexTmp = "$RemoteBase/packs.json.tmp-$PID"
$indexFinal = "$RemoteBase/packs.json"
try {
  Invoke-SftpUpload -LocalPath $tempIndex.FullName -RemotePath $indexTmp
  Invoke-Ssh -RemoteCommand "mv '$indexTmp' '$indexFinal'"
} finally {
  Remove-Item -LiteralPath $tempIndex.FullName -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Catalog: https://dionysus.dk/openmaps/packs/packs.json" -ForegroundColor Green
foreach ($p in $indexObj.packs) {
  Write-Host "  - $($p.name) ($($p.id)) — $([Math]::Round($p.totalBytes / 1MB, 1)) MB" -ForegroundColor Green
}
foreach ($collection in $indexObj.collections) {
  Write-Host "  - $($collection.name) collection ($($collection.members.Count) regions)" -ForegroundColor Green
}
