#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/deploy-target.sh
chmod 600 .env
bash scripts/compose.sh config --quiet
if [[ -n "${SILAUT_VERIFIED_IMAGE_ID:-}" ]]; then
  [[ "$SILAUT_VERIFIED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Expected a full verified image ID.' >&2; exit 1; }
  current_image=$(docker image inspect --format '{{.Id}}' "$SILAUT_APP_IMAGE")
  [[ "$current_image" == "$SILAUT_VERIFIED_IMAGE_ID" ]] || { echo 'The app tag does not match the verified image ID.' >&2; exit 1; }
  printf 'Promoting verified image %s\n' "$current_image"
else
  bash scripts/compose.sh build app
fi
bash scripts/compose.sh up -d --wait postgres redis
# Quiesce the previous version's writers before applying schema and catalog changes.
bash scripts/compose.sh stop app
bash scripts/compose.sh run --rm --no-deps bootstrap
bash scripts/compose.sh run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
bash scripts/compose.sh up -d --wait --force-recreate app caddy
bash scripts/compose.sh exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)})"
code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SILAUT_LOOPBACK_PORT/healthz")
[[ "$code" == 401 ]] || { echo "Expected unauthenticated Caddy request to return 401, got $code" >&2;exit 1; }
echo 'Silaut is running. Caddy authentication returns 401 as expected. Existing tickets and stock were preserved.'
printf 'Tunnel endpoint: http://127.0.0.1:%s/cashier (open through SSH on your Mac).\n' "$SILAUT_LOOPBACK_PORT"
