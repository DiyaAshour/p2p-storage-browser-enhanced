param(
  [string]$ServerIp = "54.166.171.208",
  [string]$SshUser = "ubuntu",
  [string]$SshKey = "C:\aaa\P2P.pem",
  [switch]$SkipDeleteToken
)

$ErrorActionPreference = "Stop"

function Set-EnvDefault([string]$Name, [string]$Value) {
  if (-not [Environment]::GetEnvironmentVariable($Name, "Process")) {
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  }
}

Set-EnvDefault "P2P_TARGET_REPLICAS" "3"
Set-EnvDefault "P2P_BOOTSTRAP_URL" "ws://$ServerIp`:8788"
Set-EnvDefault "P2P_MANIFEST_SYNC_URL" "http://$ServerIp`:8790"
Set-EnvDefault "P2P_MANIFEST_SYNC_DISABLED" "false"
Set-EnvDefault "P2P_SAFETY_PEER_URL" "ws://$ServerIp`:8792"
Set-EnvDefault "P2P_SAFETY_PEER_MODE" "emergency"
Set-EnvDefault "P2P_TRANSPORT_PORT" "8787"
Set-EnvDefault "P2P_TRANSPORT_HOST" "0.0.0.0"

if (-not $SkipDeleteToken) {
  $existingToken = [Environment]::GetEnvironmentVariable("P2P_SAFETY_PEER_DELETE_TOKEN", "Process")
  if (-not $existingToken) {
    if (Test-Path $SshKey) {
      try {
        $token = ssh -i $SshKey "$SshUser@$ServerIp" "cat /data/chunknet-data/storage-delete-token.txt" 2>$null
        $token = ($token | Out-String).Trim()
        if ($token) {
          [Environment]::SetEnvironmentVariable("P2P_SAFETY_PEER_DELETE_TOKEN", $token, "Process")
          [Environment]::SetEnvironmentVariable("STORAGE_PEER_ADMIN_TOKEN", $token, "Process")
          Write-Host "[cloud-dev] Safety delete token loaded." -ForegroundColor Green
        } else {
          Write-Host "[cloud-dev] Safety delete token was empty. Delete from safety peer may fail." -ForegroundColor Yellow
        }
      } catch {
        Write-Host "[cloud-dev] Could not load safety delete token. Delete from safety peer may fail." -ForegroundColor Yellow
        Write-Host $_.Exception.Message -ForegroundColor DarkYellow
      }
    } else {
      Write-Host "[cloud-dev] SSH key not found: $SshKey. Delete from safety peer may fail." -ForegroundColor Yellow
    }
  }
}

Write-Host "[cloud-dev] Bootstrap: $env:P2P_BOOTSTRAP_URL" -ForegroundColor Cyan
Write-Host "[cloud-dev] Manifest:  $env:P2P_MANIFEST_SYNC_URL" -ForegroundColor Cyan
Write-Host "[cloud-dev] Safety:    $env:P2P_SAFETY_PEER_URL" -ForegroundColor Cyan
Write-Host "[cloud-dev] Replicas:  $env:P2P_TARGET_REPLICAS" -ForegroundColor Cyan

pnpm run electron:dev
