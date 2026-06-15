# Expose Dev Helper on the internet - FREE, no credit card.
# Uses Cloudflare Quick Tunnel (random *.trycloudflare.com URL each run).
#
# Usage (from project root):
#   .\scripts\start-public.ps1

$ErrorActionPreference = "Stop"
$Port = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Test-PortListening([int]$p) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  return [bool]$conn
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

function Ensure-Cloudflared {
  $path = Get-CloudflaredPath
  if ($path) { return $path }

  Write-Host "cloudflared not found. Installing via winget..."
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  $path = Get-CloudflaredPath
  if (-not $path) {
    throw "Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
  }
  return $path
}

if (-not (Test-PortListening $Port)) {
  Write-Host "Starting Dev Helper on port $Port..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory $Root -WindowStyle Normal
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortListening $Port) { break }
    Start-Sleep -Seconds 1
  }
  if (-not (Test-PortListening $Port)) {
    throw "Server did not start on port $Port. Run 'npm start' manually and retry."
  }
}

$cloudflared = Ensure-Cloudflared
$localUrl = "http://127.0.0.1:" + $Port

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Dev Helper public tunnel (no card)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Local:  $localUrl"
Write-Host ""
Write-Host "Cloudflare will print a public URL like:"
Write-Host "  https://something-random.trycloudflare.com"
Write-Host ""
Write-Host "After it appears, set in .env (then restart npm start):"
Write-Host "  PUBLIC_BASE_URL=https://your-url.trycloudflare.com"
Write-Host ""
Write-Host "Press Ctrl+C to stop the tunnel (server keeps running)."
Write-Host ""

& $cloudflared tunnel --url $localUrl
