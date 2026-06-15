# Start Dev Helper server + Cloudflare public tunnel (keep this window open).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$Port = if ($env:PORT) { [int]$env:PORT } else { 3000 }

function Test-PortListening([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Get-CloudflaredPath {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $paths = @(
    "$env:ProgramFiles\Cloudflare\cloudflared\cloudflared.exe",
    "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
  )
  foreach ($p in $paths) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

if (-not (Test-PortListening $Port)) {
  Write-Host "Starting server on port $Port..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory $Root -WindowStyle Normal
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortListening $Port) { break }
    Start-Sleep -Seconds 1
  }
  if (-not (Test-PortListening $Port)) {
    throw "Server did not start. Run 'npm start' manually in another terminal."
  }
} else {
  Write-Host "Server already running on port $Port."
}

$cloudflared = Get-CloudflaredPath
if (-not $cloudflared) {
  Write-Host "Installing cloudflared..."
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  $cloudflared = Get-CloudflaredPath
}

if (-not $cloudflared) {
  throw "cloudflared not found. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
}

Write-Host ""
Write-Host "Public tunnel starting - copy the https://....trycloudflare.com URL below."
Write-Host "Set PUBLIC_BASE_URL in .env to that URL, then restart npm start."
Write-Host ""

& $cloudflared tunnel --url ("http://127.0.0.1:" + $Port)
