#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/deploy-target.sh
[[ "${SILAUT_DEPLOY_TARGET:-}" == rehearsal ]] || { echo 'Select the rehearsal target.' >&2; exit 1; }
umask 077
run_dir="$HOME/silaut-rehearsals/$SILAUT_REHEARSAL_ID"
[[ "$PWD" == "$run_dir/silaut" ]] || { echo 'Run from the staged rehearsal source.' >&2; exit 1; }
dump="$HOME/silaut-backups/silaut-v1-rehearsal-$SILAUT_REHEARSAL_ID.dump"
volume="${SILAUT_COMPOSE_PROJECT}_postgres-data"
test -s "$dump"
if docker volume inspect "$volume" >/dev/null 2>&1; then
  echo "The rehearsal volume $volume already exists. Use a fresh rehearsal ID." >&2
  exit 1
fi

mkdir -p evidence
sha256sum "$run_dir/silaut-v2-rc.zip" > evidence/source.sha256
sha256sum "$dump" > evidence/restore.sha256
bash scripts/compose.sh config --quiet
df -h /var/lib/docker
free -m
bash scripts/compose.sh up -d --wait postgres redis
db=$(bash scripts/compose.sh ps -q postgres)
mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$db")
[[ "$mount" == "$volume" ]] || { echo 'Unexpected rehearsal database mount.' >&2; exit 1; }
bash scripts/compose.sh exec -T postgres pg_restore -U silaut_owner -d "$SILAUT_DB_NAME" \
  --no-owner --no-privileges --exit-on-error < "$dump"

sql() {
  bash scripts/compose.sh exec -T postgres psql -XAtq -v ON_ERROR_STOP=1 -U silaut_owner -d "$SILAUT_DB_NAME" "$@"
}
sql < scripts/v1-history.sql > evidence/v1-before.json
bash scripts/deploy.sh
sql < scripts/v1-history.sql > evidence/v1-after.json
python3 scripts/compare-v1-history.py evidence/v1-before.json evidence/v1-after.json | tee evidence/history-check.json
sql < scripts/verify-upgraded-history.sql | tee evidence/upgrade-check.json

app=$(bash scripts/compose.sh ps -q app)
caddy=$(bash scripts/compose.sh ps -q caddy)
published=$(docker port "$caddy" 8080/tcp)
[[ "$published" == "127.0.0.1:$SILAUT_LOOPBACK_PORT" ]]
[[ "$(docker port "$caddy")" == "8080/tcp -> 127.0.0.1:$SILAUT_LOOPBACK_PORT" ]]
[[ -z "$(docker port "$db")" ]]
[[ -z "$(docker port "$(bash scripts/compose.sh ps -q redis)")" ]]
image=$(docker inspect --format '{{.Image}}' "$app")
[[ "$image" == "$(docker image inspect --format '{{.Id}}' "$SILAUT_APP_IMAGE")" ]]
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/amd64 ]]
printf '%s\n' "$image" > evidence/verified-image.id
printf '%s\n' "$SILAUT_COMPOSE_PROJECT $SILAUT_DB_NAME $mount $SILAUT_APP_IMAGE $image $published linux/amd64" | tee evidence/isolation.txt
bash scripts/compose.sh ps
