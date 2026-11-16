#!/usr/bin/env bash
set -euo pipefail
id=${1:?Supply the rehearsal ID}
[[ "$id" =~ ^[a-z0-9]{8,32}$ ]] || exit 1
cd "$HOME/apps"
live="$PWD/silaut"
prior="$PWD/silaut-v1-$id"
retained="$PWD/silaut-v2-$id-rollback"
tag="silaut-app:rollback-v1-$id"
[[ -d "$prior" && ! -e "$retained" ]]
docker image inspect "$tag" >/dev/null
docker volume inspect silaut-demo_postgres-data >/dev/null
if [[ -e "$live" ]]; then
  grep -qx "SILAUT_LIVE_DB_VOLUME=silaut-demo-v2-$id-pg" "$live/.env"
  (cd "$live" && unset SILAUT_DEPLOY_TARGET && bash scripts/compose.sh stop app caddy postgres)
  mv "$live" "$retained"
fi
mv "$prior" "$live"
docker image tag "$tag" silaut-app:local
cd "$live"
unset SILAUT_DEPLOY_TARGET
bash scripts/compose.sh up -d --no-build --wait postgres redis app caddy
db=$(bash scripts/compose.sh ps -q postgres)
[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$db")" == silaut-demo_postgres-data ]]
[[ "$(docker inspect --format '{{.Image}}' "$(bash scripts/compose.sh ps -q app)")" == "$(docker image inspect --format '{{.Id}}' "$tag")" ]]
bash scripts/compose.sh ps
