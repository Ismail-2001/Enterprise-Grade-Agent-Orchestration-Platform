#!/usr/bin/env pwsh
# ==============================================================================
# E-GAOP Staging Setup — One-Command EC2 Provisioning + GitHub Secrets
# ==============================================================================
# Usage:
#   .\scripts\setup-staging.ps1 -EC2IP <ip> -PemPath C:\keys\egaop-staging.pem
#
# Prerequisites:
#   - EC2 instance running (Ubuntu 24.04, t3a.xlarge, 50 GB gp3)
#   - SSH (.pem) key for root access
#   - GitHub CLI (gh) installed: winget install --id GitHub.cli
# =============================================================================

param(
  [Parameter(Mandatory = $true)]
  [string]$EC2IP,
  [Parameter(Mandatory = $true)]
  [string]$PemPath,
  [Parameter(Mandatory = $false)]
  [string]$Repo = "",  # e.g. "username/repo" — defaults to current directory git remote
  [Parameter(Mandatory = $false)]
  [switch]$SkipSecrets
)

$ErrorActionPreference = "Stop"

# Resolve SSH key path
$PemPath = Resolve-Path -LiteralPath $PemPath -ErrorAction Stop

# ─── Colors ───────────────────────────────────────────────────────────────────
$Host.UI.RawUI.ForegroundColor = "Cyan"
Write-Output "═══════════════════════════════════════════════════════════════════"
Write-Output "  E-GAOP Staging Setup — Provision + Configure"
Write-Output "═══════════════════════════════════════════════════════════════════"
Write-Output ""
$Host.UI.RawUI.ForegroundColor = "White"

# ─── 1. Validate SSH access ──────────────────────────────────────────────────
Write-Host "[1/5] Validating SSH access to root@$EC2IP..." -ForegroundColor Yellow
$result = & ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i $PemPath "root@$EC2IP" "echo OK" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FAIL] Cannot SSH to root@$EC2IP. Check the IP and PEM path." -ForegroundColor Red
  Write-Host "  Error: $result" -ForegroundColor Red
  exit 1
}
Write-Host "[OK] SSH access confirmed" -ForegroundColor Green

# ─── 2. Copy and run provisioning script ─────────────────────────────────────
Write-Host "[2/5] Copying provision-staging.sh to EC2 instance..." -ForegroundColor Yellow
$scriptPath = Join-Path $PSScriptRoot "provision-staging.sh"
& scp -i $PemPath -o StrictHostKeyChecking=accept-new $scriptPath "root@$EC2IP:/tmp/provision-staging.sh" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FAIL] Failed to copy provisioning script" -ForegroundColor Red
  exit 1
}

Write-Host "Running provisioning script (this may take 2-3 minutes)..." -ForegroundColor Yellow
$result = & ssh -i $PemPath "root@$EC2IP" "bash /tmp/provision-staging.sh" 2>&1
$exitCode = $LASTEXITCODE
Write-Output $result
if ($exitCode -ne 0) {
  Write-Host "[FAIL] Provisioning script failed (exit code: $exitCode)" -ForegroundColor Red
  exit 1
}
Write-Host "[OK] Server provisioned" -ForegroundColor Green

# ─── 3. Add deploy SSH public key ────────────────────────────────────────────
Write-Host "[3/5] Adding deploy SSH public key to egaop user..." -ForegroundColor Yellow
$pubKeyPath = Join-Path $env:TEMP "egaop-staging-keys\egaop-staging.pub"
if (Test-Path -LiteralPath $pubKeyPath) {
  $pubKey = Get-Content -LiteralPath $pubKeyPath -Raw
  & ssh -i $PemPath "root@$EC2IP" "echo '$pubKey' >> /home/egaop/.ssh/authorized_keys && chmod 600 /home/egaop/.ssh/authorized_keys && chown egaop:egaop /home/egaop/.ssh/authorized_keys" 2>&1
  Write-Host "[OK] Deploy SSH public key added" -ForegroundColor Green
} else {
  Write-Host "[WARN] SSH public key not found at $pubKeyPath" -ForegroundColor Yellow
  Write-Host "  You must add it manually:"
  Write-Host "  ssh -i $PemPath root@$EC2IP 'echo \"<your-key>\" >> /home/egaop/.ssh/authorized_keys'"
}

# ─── 4. Validate egaop user can access Docker ─────────────────────────────────
Write-Host "[4/5] Validating egaop user Docker access..." -ForegroundColor Yellow
$result = & ssh -i $PemPath "root@$EC2IP" "sudo -u egaop docker info --format '{{.ServerVersion}}'" 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host "[OK] egaop user can access Docker v$result" -ForegroundColor Green
} else {
  Write-Host "[WARN] egaop user cannot access Docker: $result" -ForegroundColor Yellow
  Write-Host "  You may need to log out and back in for group changes to take effect."
}

# ─── 5. Install GitHub CLI and configure secrets ────────────────────────────
Write-Host "[5/5] Configuring GitHub secrets..." -ForegroundColor Yellow

# Install gh if not present
$ghCheck = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCheck) {
  Write-Host "  GitHub CLI not found — attempting to install..." -ForegroundColor Yellow
  & winget install --id GitHub.cli -e --accept-package-agreements --silent 2>$null
  # Add to PATH for current session
  $env:Path += ";$env:LOCALAPPDATA\GitHubCLI\bin;$env:ProgramFiles\GitHub CLI\bin"
  $ghCheck = Get-Command gh -ErrorAction SilentlyContinue
}

# Resolve repo
if (-not $Repo) {
  $remoteUrl = & git remote get-url origin 2>$null
  if ($remoteUrl -match 'github\.com[:\/](.+\/.+)\.git') {
    $Repo = $Matches[1]
  } elseif ($remoteUrl -match 'github\.com\/(.+)') {
    $Repo = $remoteUrl -replace '^.*github\.com\/' -replace '\.git$'
  }
}

if (-not $Repo) {
  Write-Host "[WARN] Could not determine repo. Set secrets manually via GitHub web UI:" -ForegroundColor Yellow
  Write-Host "  https://github.com/<owner>/<repo>/settings/secrets/actions"
  Write-Host ""
  Write-Host "  Required secrets:"
  Write-Host "    STAGING_HOST     = $EC2IP"
  Write-Host "    STAGING_USER     = egaop"
  Write-Host "    STAGING_SSH_KEY  = (contents of $env:TEMP\egaop-staging-keys\egaop-staging)"
  Write-Host ""
  Write-Host "  Plus: POSTGRES_PASSWORD, JWT_SECRET, EGAOP_MASTER_ENCRYPTION_KEY,"
  Write-Host "        OPENAI_API_KEY, REDIS_PASSWORD, GRAFANA_PASSWORD, INTERNAL_SERVICE_TOKEN"
  exit 0
}

if ($ghCheck) {
  # Check auth status
  $authStatus = & gh auth status 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  Please authenticate GitHub CLI:" -ForegroundColor Yellow
    & gh auth login
  }

  Write-Host "  Setting secrets for $Repo ..." -ForegroundColor Yellow
  $secrets = @{
    "STAGING_HOST" = $EC2IP
    "STAGING_USER" = "egaop"
  }

  # Read SSH private key
  $privKeyPath = Join-Path $env:TEMP "egaop-staging-keys\egaop-staging"
  if (Test-Path -LiteralPath $privKeyPath) {
    $secrets["STAGING_SSH_KEY"] = Get-Content -LiteralPath $privKeyPath -Raw
  }

  # Read generated secrets
  $secretsFile = Join-Path $env:TEMP "egaop-secrets\secrets.env"
  if (Test-Path -LiteralPath $secretsFile) {
    Get-Content -LiteralPath $secretsFile | ForEach-Object {
      $parts = $_ -split '=', 2
      if ($parts.Count -eq 2) {
        $secrets[$parts[0]] = $parts[1]
      }
    }
  }

  # You'll need to provide OPENAI_API_KEY manually
  $openaiKey = [System.Environment]::GetEnvironmentVariable("OPENAI_API_KEY")
  if ($openaiKey) {
    $secrets["OPENAI_API_KEY"] = $openaiKey
  } else {
    Write-Host "  [WARN] OPENAI_API_KEY not found in environment" -ForegroundColor Yellow
    Write-Host "  You will need to set it manually: gh secret set OPENAI_API_KEY"
  }

  # Set each secret
  $secrets.GetEnumerator() | ForEach-Object {
    $name = $_.Key
    $value = $_.Value
    if ($value) {
      $value | gh secret set $name --repo $Repo 2>$null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] $name set" -ForegroundColor Green
      } else {
        Write-Host "  [FAIL] Failed to set $name" -ForegroundColor Red
      }
    }
  }

  # Set STAGING_HOST as a variable too (for the Docker Compose .env)
  Write-Host "  Setting repository variables..." -ForegroundColor Yellow
  & gh variable set STAGING_HOST --body $EC2IP --repo $Repo 2>$null
  & gh variable set LAST_SUCCESSFUL_DEPLOY_TAG --body "never" --repo $Repo 2>$null
  Write-Host "  [OK] Repository variables set" -ForegroundColor Green
} else {
  Write-Host "[WARN] GitHub CLI not available. Set secrets manually." -ForegroundColor Yellow
  Write-Host "  Install: winget install --id GitHub.cli"
  Write-Host "  Or set via: https://github.com/$Repo/settings/secrets/actions"
}

# ─── Summary ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  ✅  Staging setup complete" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next: Push to main to trigger CI/CD:"
Write-Host "    git add -A"
Write-Host '    git commit -m "feat: staging infrastructure setup"'
Write-Host "    git push origin main"
Write-Host ""
Write-Host "  Monitor:"
Write-Host "    CI:       https://github.com/$Repo/actions/workflows/ci.yml"
Write-Host "    Security: https://github.com/$Repo/actions/workflows/security-scan.yml"
Write-Host "    Deploy:   https://github.com/$Repo/actions/workflows/deploy.yml"
Write-Host ""
Write-Host "  SSH to staging: ssh -i $PemPath egaop@$EC2IP"
Write-Host ""
