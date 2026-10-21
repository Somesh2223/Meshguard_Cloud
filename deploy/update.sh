#!/usr/bin/env bash
# Rebuild and restart after new code arrives (git pull, or a re-uploaded archive).
# Run on the EC2 instance: bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d .git ]; then git pull --ff-only; fi
(cd client && npm ci && npm run build)
(cd server && npm ci --omit=dev)
sudo systemctl restart disaster-sos
sleep 2
curl -sf http://127.0.0.1:8080/api/health && echo " <- server healthy"
