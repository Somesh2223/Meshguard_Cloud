#!/usr/bin/env bash
# One-time setup of the Disaster SOS system on a fresh Ubuntu EC2 instance.
#
# Targets Ubuntu 24.04 / 26.04 LTS.
# Usage (on the instance, from the project folder):
#   sudo DASHBOARD_KEY='choose-a-strong-passcode' bash deploy/setup-ec2.sh
#
# Installs Node.js 24 and Caddy, builds the apps, and runs the server as a
# systemd service behind Caddy, which gets a free HTTPS certificate for
# <public-ip>.sslip.io. HTTPS is required: phones only allow GPS, camera
# (QR pairing), motion sensors and offline install on secure origins.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
if [[ -z "${DASHBOARD_KEY:-}" ]]; then echo "Set DASHBOARD_KEY (the rescuer passcode)." >&2; exit 1; fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="${SUDO_USER:-ubuntu}"

# Public IP from the EC2 instance metadata service (IMDSv2).
TOKEN=$(curl -sfX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
PUBLIC_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
DOMAIN="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
echo "==> Setting up for https://$DOMAIN"

# Free-tier instances have 1 GB RAM; the frontend build needs more, so add swap.
if [[ ! -f /swapfile ]] && (( $(awk '/MemTotal/ {print $2}' /proc/meminfo) < 2000000 )); then
    echo "==> Adding 2 GB swap (small instance)"
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing Node.js, Caddy and sqlite3"
apt-get update -y
apt-get install -y curl ca-certificates gnupg sqlite3

# The server needs Node.js 22.13+ (built-in node:sqlite). Prefer NodeSource's
# Node 24; if its repository is unavailable for this Ubuntu release, fall back
# to Ubuntu's own package and check that it is new enough.
if ! { curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs; }; then
    echo "==> NodeSource unavailable; using Ubuntu's Node.js"
    rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources
    apt-get update -y
    apt-get install -y nodejs npm
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    echo "Node.js $(node -v) is too old; 22.13 or newer is required." >&2
    exit 1
fi
echo "    Node.js $(node -v), npm $(npm -v)"

# Ubuntu's archive ships Caddy, so no third-party repository is needed.
apt-get install -y caddy

echo "==> Building the victim app and rescuer dashboard"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR/client' && npm ci && npm run build"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR/server' && npm ci --omit=dev && npm run seed"

echo "==> Installing the systemd service"
install -d -m 700 -o "$APP_USER" /etc/disaster-sos
cat > /etc/disaster-sos/env <<EOF
PORT=8080
HOST=127.0.0.1
DASHBOARD_KEY=$DASHBOARD_KEY
DB_FILE=$APP_DIR/server/data/sos.db
EOF
chmod 600 /etc/disaster-sos/env
chown "$APP_USER" /etc/disaster-sos/env

sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__APP_USER__#$APP_USER#g" \
    "$APP_DIR/deploy/disaster-sos.service" > /etc/systemd/system/disaster-sos.service
systemctl daemon-reload
systemctl enable --now disaster-sos

echo "==> Configuring Caddy (HTTPS reverse proxy)"
sed "s#__DOMAIN__#$DOMAIN#g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "==> Daily database backup at 02:00 (kept 7 days)"
cat > /etc/cron.d/disaster-sos-backup <<EOF
0 2 * * * $APP_USER mkdir -p $APP_DIR/server/backups && sqlite3 $APP_DIR/server/data/sos.db ".backup '$APP_DIR/server/backups/sos-\$(date +\%F).db'" && find $APP_DIR/server/backups -name 'sos-*.db' -mtime +7 -delete
EOF

sleep 2
if curl -sf http://127.0.0.1:8080/api/health > /dev/null; then
    echo
    echo "Done."
    echo "  Victim app:       https://$DOMAIN/"
    echo "  Rescuer dashboard: https://$DOMAIN/dashboard"
    echo "  Logs:             journalctl -u disaster-sos -f"
else
    echo "Server did not start; check: journalctl -u disaster-sos -n 50" >&2
    exit 1
fi
