# Exercises the real Windows NSIS installer on a clean Windows account: silent per-user install,
# registry entry, shortcuts, packaged launch smoke test, reinstall over the existing copy (the
# upgrade path, which runs the old uninstaller with --updated), then silent uninstall. Workspace
# data in %APPDATA%\weft must survive both; the disposable update cache must not survive uninstall.
# Usage: pwsh -File scripts/release/windows-install-check.ps1 <Weft-Setup-X.Y.Z-x64.exe> <X.Y.Z>
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = 'Stop'
$smoke = Join-Path $PSScriptRoot 'smoke-packaged.js'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$profileDir = Join-Path $env:APPDATA 'weft'
$sentinel = Join-Path $profileDir 'installer-check-keep.txt'
$updateCache = Join-Path $profileDir 'updates'
$startMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Weft.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Weft.lnk'

function Fail([string]$message) {
  Write-Host "::error::Windows installer check failed: $message"
  exit 1
}
function Get-WeftEntry {
  @(Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like 'Weft *' })
}
function Split-Command([string]$command) {
  if ($command -notmatch '^"([^"]+)"\s*(.*)$') { Fail "unexpected uninstall command: $command" }
  @($Matches[1], $Matches[2])
}
function Wait-Until([scriptblock]$condition, [string]$what, [int]$seconds = 180) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $condition)) {
    if ((Get-Date) -gt $deadline) { Fail "timed out after $seconds s waiting for $what" }
    Start-Sleep -Milliseconds 500
  }
}
function Install-Weft([string]$label) {
  # NSIS installers return only after the install section has finished.
  $process = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "$label exited with $($process.ExitCode)" }
  $entries = @(Get-WeftEntry)
  if ($entries.Count -ne 1) { Fail "$label left $($entries.Count) per-user uninstall entries (expected 1)" }
  $entry = $entries[0]
  if ($entry.DisplayVersion -ne $Version) { Fail "$label registered version $($entry.DisplayVersion), expected $Version" }
  $uninstaller = (Split-Command $entry.UninstallString)[0]
  $installDir = Split-Path -Parent $uninstaller
  $exe = Join-Path $installDir 'Weft.exe'
  if (-not (Test-Path -LiteralPath $exe)) { Fail "$label did not install $exe" }
  if (-not $installDir.StartsWith((Join-Path $env:LOCALAPPDATA 'Programs'), [StringComparison]::OrdinalIgnoreCase)) { Fail "$label installed outside the per-user Programs folder: $installDir" }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($link in @($startMenuLink, $desktopLink)) {
    if (-not (Test-Path -LiteralPath $link)) { Fail "$label did not create $link" }
    $target = $shell.CreateShortcut($link).TargetPath
    if ($target -ne $exe) { Fail "$link points to $target, expected $exe" }
  }
  if (-not (Test-Path -LiteralPath $sentinel)) { Fail "$label removed workspace data in $profileDir" }
  Write-Host "${label}: Weft $Version installed per-user at $installDir"
  return @{ Entry = $entry; Exe = $exe; Dir = $installDir }
}
function Invoke-Smoke([string]$exe) {
  & node $smoke $exe nsis
  if ($LASTEXITCODE -ne 0) { Fail "packaged smoke test of the installed app exited with $LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $Installer)) { Fail "installer not found: $Installer" }
if ((Get-WeftEntry).Count -ne 0) { Fail 'Weft is already installed for this account; run on a clean machine' }
if (Test-Path -LiteralPath $sentinel) { Fail "$sentinel is left over from an earlier check" }
$profileExisted = Test-Path -LiteralPath $profileDir

# Stand-ins for a person's workspaces and a staged update.
New-Item -ItemType Directory -Force -Path $updateCache | Out-Null
Set-Content -LiteralPath $sentinel -Value 'Weft installer check: this file must survive upgrade and uninstall.'
Set-Content -LiteralPath (Join-Path $updateCache 'staged.bin') -Value 'disposable'

$installed = Install-Weft 'install'
Invoke-Smoke $installed.Exe

$installed = Install-Weft 'reinstall over the existing copy'
if (-not (Test-Path -LiteralPath $updateCache)) { Fail 'reinstall removed the update cache (upgrades must not touch user data)' }
Invoke-Smoke $installed.Exe

$command, $arguments = Split-Command $installed.Entry.QuietUninstallString
if ($arguments -notmatch '/S') { Fail "QuietUninstallString is not silent: $($installed.Entry.QuietUninstallString)" }
$process = Start-Process -FilePath $command -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { Fail "uninstaller exited with $($process.ExitCode)" }
# The NSIS uninstaller re-launches itself from a temporary copy, so completion is observed, not awaited.
Wait-Until { (Get-WeftEntry).Count -eq 0 -and -not (Test-Path -LiteralPath $installed.Exe) } 'the uninstaller to remove Weft'
foreach ($link in @($startMenuLink, $desktopLink)) { if (Test-Path -LiteralPath $link) { Fail "uninstall left $link" } }
if (-not (Test-Path -LiteralPath $sentinel)) { Fail "silent uninstall removed workspace data in $profileDir" }
if (Test-Path -LiteralPath $updateCache) { Fail 'uninstall left the disposable update cache' }

if ($profileExisted) { Remove-Item -LiteralPath $sentinel -Force } else { Remove-Item -LiteralPath $profileDir -Recurse -Force }
Write-Host "Windows installer check passed: install, launch, reinstall, launch and uninstall of Weft $Version; workspace data kept."
