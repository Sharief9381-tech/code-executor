# Run this in PowerShell as Administrator
# This enables WSL2 and installs Ubuntu automatically

Write-Host "Enabling WSL2..." -ForegroundColor Cyan
wsl --install -d Ubuntu-22.04

Write-Host ""
Write-Host "WSL2 + Ubuntu installed." -ForegroundColor Green
Write-Host "After restart, open 'Ubuntu' from Start Menu, set a username/password."
Write-Host "Then run: wsl -d Ubuntu-22.04 and follow setup-in-wsl.sh"
