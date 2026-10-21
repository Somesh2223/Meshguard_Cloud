#!/usr/bin/env bash
# Rebuild and restart after new code arrives (git pull, or a re-uploaded archive).
# Run on the EC2 instance: bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d .git ]; then git pull --ff-only; fi

# Build first while the old version keeps serving.
(cd client && npm ci && npm run build)

# Stop the server before replacing its packages, so it never runs half-updated.
sudo systemctl stop disaster-sos
(cd server && npm ci --omit=dev)
sudo systemctl start disaster-sos

for _ in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8080/api/health > /dev/null; then
        echo "Server healthy."
        exit 0
    fi
    sleep 1
done
echo "Server did not come back within 30 s. Recent logs:" >&2
journalctl -u disaster-sos -n 40 --no-pager >&2
exit 1
