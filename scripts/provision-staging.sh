#!/usr/bin/env bash
# ==============================================================================
# Staging Infrastructure Provisioner — The Kubernetes of AI Agents
# ==============================================================================
# Usage (as root):
#   curl -fsSL https://raw.githubusercontent.com/.../scripts/provision-staging.sh | bash
#
# Or locally:
#   sudo bash scripts/provision-staging.sh
#
# What it does:
#   1. Installs Docker Engine 24+ with Compose v2 plugin
#   2. Creates a dedicated 'egaop' user for CI/CD deploys
#   3. Configures SSH authorized_keys for the deploy key
#   4. Hardens SSH (key-only, no root login)
#   5. Validates the environment is ready for 'docker compose up'
# ==============================================================================

set -euo pipefail

SCRIPT_VERSION="1.0.0"
EGAOP_USER="egaop"
EGAOP_HOME="/home/${EGAOP_USER}"
COMPOSE_DIR="${EGAOP_HOME}/egaop-staging"

# ─── Color helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $1"; exit 1; }

echo "═══════════════════════════════════════════════════════════════════════"
echo "  E-GAOP Staging Infrastructure Provisioner v${SCRIPT_VERSION}"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# ─── Prerequisites ───────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  fail "This script must be run as root (use sudo)."
fi

OS=""
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS=$ID
fi

case "$OS" in
  ubuntu|debian)
    info "Detected OS: $OS $VERSION_ID"
    PKG_MANAGER="apt-get"
    ;;
  centos|rhel|fedora)
    info "Detected OS: $OS $VERSION_ID"
    PKG_MANAGER="dnf"
    ;;
  *)
    fail "Unsupported OS '$OS'. Supported: ubuntu, debian, centos, rhel, fedora"
    ;;
esac

# ─── 1. Install Docker ──────────────────────────────────────────────────────

info "Installing Docker Engine..."

case "$PKG_MANAGER" in
  apt-get)
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/${OS}/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${OS} $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    ;;
  dnf)
    dnf install -y dnf-plugins-core
    dnf config-manager --add-repo https://download.docker.com/linux/${OS}/docker-ce.repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    ;;
esac

systemctl start docker
systemctl enable docker
ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') installed"
ok "Compose $(docker compose version --short) installed"

# ─── 2. Create egaop user ───────────────────────────────────────────────────

info "Setting up '${EGAOP_USER}' user..."

if id "${EGAOP_USER}" &>/dev/null; then
  warn "User '${EGAOP_USER}' already exists — skipping creation"
else
  useradd -m -s /bin/bash -G docker "${EGAOP_USER}"
  ok "User '${EGAOP_USER}' created and added to 'docker' group"
fi

# Ensure docker group membership
usermod -aG docker "${EGAOP_USER}"

# ─── 3. SSH authorized_keys ─────────────────────────────────────────────────

info "Configuring SSH access..."

mkdir -p "${EGAOP_HOME}/.ssh"
chmod 700 "${EGAOP_HOME}/.ssh"

AUTH_KEYS="${EGAOP_HOME}/.ssh/authorized_keys"

if [[ ! -f "${AUTH_KEYS}" ]]; then
  touch "${AUTH_KEYS}"
  warn "Created empty authorized_keys — you must add the deploy SSH public key:"
  echo ""
  echo "    echo '<deploy-public-key>' >> ${AUTH_KEYS}"
  echo ""
fi

chmod 600 "${AUTH_KEYS}"
chown -R "${EGAOP_USER}:${EGAOP_USER}" "${EGAOP_HOME}/.ssh"

ok "SSH authorized_keys ready at ${AUTH_KEYS}"

# ─── 4. SSH hardening ──────────────────────────────────────────────────────

info "Hardening SSH configuration..."

SSHD_CONFIG="/etc/ssh/sshd_config"

# Disable root login
if grep -q "^PermitRootLogin" "${SSHD_CONFIG}"; then
  sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' "${SSHD_CONFIG}"
else
  echo "PermitRootLogin no" >> "${SSHD_CONFIG}"
fi

# Enable key-only auth
if grep -q "^PasswordAuthentication" "${SSHD_CONFIG}"; then
  sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' "${SSHD_CONFIG}"
else
  echo "PasswordAuthentication no" >> "${SSHD_CONFIG}"
fi

# Enable public key auth
if grep -q "^PubkeyAuthentication" "${SSHD_CONFIG}"; then
  sed -i 's/^PubkeyAuthentication.*/PubkeyAuthentication yes/' "${SSHD_CONFIG}"
else
  echo "PubkeyAuthentication yes" >> "${SSHD_CONFIG}"
fi

systemctl restart sshd || systemctl restart ssh
ok "SSH hardened (key-only, root login disabled)"

# ─── 5. Create compose directory ─────────────────────────────────────────────

info "Setting up deployment directory..."

mkdir -p "${COMPOSE_DIR}"
chown "${EGAOP_USER}:${EGAOP_USER}" "${COMPOSE_DIR}"
ok "Deployment directory: ${COMPOSE_DIR}"

# ─── 6. Validate ─────────────────────────────────────────────────────────────

echo ""
echo "── Validation ──"
echo ""

ERRORS=0

# Check Docker
if docker info &>/dev/null; then
  ok "Docker daemon is running"
else
  warn "Docker daemon not reachable — try: sudo systemctl restart docker"
  ERRORS=$((ERRORS + 1))
fi

# Check Compose
if docker compose version &>/dev/null; then
  ok "Docker Compose v2 is available"
else
  warn "Docker Compose v2 not found"
  ERRORS=$((ERRORS + 1))
fi

# Check egaop user
if id "${EGAOP_USER}" &>/dev/null; then
  ok "User '${EGAOP_USER}' exists with groups: $(id -Gn "${EGAOP_USER}")"
fi

# Check docker socket access
if sudo -u "${EGAOP_USER}" docker info &>/dev/null; then
  ok "User '${EGAOP_USER}' can access Docker (no sudo)"
else
  warn "User '${EGAOP_USER}' cannot access Docker — verify group membership: sudo usermod -aG docker ${EGAOP_USER}"
  ERRORS=$((ERRORS + 1))
fi

# Disk space
AVAILABLE_GB=$(df -BG --output=avail "${EGAOP_HOME}" 2>/dev/null | tail -1 | tr -d 'G ')
if [[ -n "$AVAILABLE_GB" && "$AVAILABLE_GB" -ge 20 ]]; then
  ok "Disk space: ${AVAILABLE_GB}G available (>= 20G)"
else
  warn "Disk space: ${AVAILABLE_GB}G available (< 20G recommended for production-like workloads)"
fi

# Memory
TOTAL_GB=$(free -g | awk '/^Mem:/{print $2}')
if [[ -n "$TOTAL_GB" && "$TOTAL_GB" -ge 4 ]]; then
  ok "Memory: ${TOTAL_GB}G total (>= 4G)"
else
  warn "Memory: ${TOTAL_GB}G total (< 4G may cause issues under load)"
fi

echo ""
if [[ "$ERRORS" -eq 0 ]]; then
  echo "═══════════════════════════════════════════════════════════════════════"
  echo "  ✅  Provisioning complete — staging server is ready"
  echo "═══════════════════════════════════════════════════════════════════════"
  echo ""
  echo "  Next steps:"
  echo "    1. Add the deploy SSH public key:"
  echo "       echo '<deploy-key>' >> ${AUTH_KEYS}"
  echo ""
  echo "    2. Set GitHub secrets:"
  echo "       STAGING_HOST     = $(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
  echo "       STAGING_USER     = ${EGAOP_USER}"
  echo "       STAGING_SSH_KEY  = <private key matching the public key above>"
  echo ""
  echo "    3. Push to main — CI/CD will deploy automatically"
  echo ""
else
  fail "${ERRORS} validation error(s) — fix and re-run"
fi
