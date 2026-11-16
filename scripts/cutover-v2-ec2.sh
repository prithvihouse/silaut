#!/usr/bin/env bash
set -euo pipefail
id=${1:?Supply the rehearsal ID}
[[ "$id" =~ ^[a-z0-9]{8,32}$ ]] || exit 1
root="$HOME/silaut-rehearsals/$id"
source_dir="$root/silaut"
evidence="$source_dir/evidence"
live="$HOME/apps/silaut"
prior="$HOME/apps/silaut-v1-$id"
staging="$HOME/apps/.silaut-v2-$id"
volume="silaut-demo-v2-$id-pg"
tag="silaut-app:rollback-v1-$id"
dump="$HOME/silaut-backups/silaut-v1-cutover-$id.dump"
umask 077
unset SILAUT_DEPLOY_TARGET

image=$(cat "$evidence/verified-image.id")
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$image" == "$(docker image inspect --format '{{.Id}}' "silaut-app:rehearsal-$id")" ]]
sha256sum -c "$evidence/source.sha256"
python3 - "$evidence/workflow-check.json" "$id" "$image" <<'PY'
import json
import sys
with open(sys.argv[1]) as file:
    report = json.load(file)
if (report['rehearsalId'], report['imageId'], report['pass']) != (sys.argv[2], sys.argv[3], True):
    sys.exit('The authenticated rehearsal did not pass on this image.')
PY

[[ ! -e "$prior" && ! -e "$staging" && ! -e "$dump" ]]
if docker volume inspect "$volume" >/dev/null 2>&1; then
  echo "The cutover volume $volume already exists." >&2
  exit 1
fi
cd "$live"
grep -qx 'DEPLOY_MODE=public' .env
! grep -q '^SILAUT_LIVE_DB_VOLUME=' .env
db=$(bash scripts/compose.sh ps -q postgres)
mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$db")
[[ "$mount" == silaut-demo_postgres-data ]]
[[ "$(bash scripts/compose.sh exec -T postgres psql -XAt -U silaut_owner -d silaut_demo -c 'SELECT count(*) FROM schema_migrations')" == 2 ]]
v1_image=$(docker inspect --format '{{.Image}}' "$(bash scripts/compose.sh ps -q app)")
docker image tag "$v1_image" "$tag"
printf '%s\n' "$v1_image" > "$evidence/v1-image.id"

mkdir -m 700 "$staging"
unzip -q "$root/silaut-v2-rc.zip" -d "$staging"
install -m 600 .env "$staging/silaut/.env"
printf '\nSILAUT_LIVE_DB_VOLUME=%s\n' "$volume" >> "$staging/silaut/.env"
(cd "$staging/silaut" && bash scripts/compose.sh config --quiet)

on_error() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    echo 'Cutover failed. Restoring the saved v1 app and database volume.' >&2
    if [[ -d "$prior" ]]; then
      bash "$source_dir/scripts/rollback-v1-ec2.sh" "$id" || echo 'Automatic rollback needs operator attention.' >&2
    else
      (cd "$live" && bash scripts/compose.sh up -d --no-build --wait app caddy) || echo 'Could not restart v1.' >&2
    fi
  fi
  exit "$status"
}
trap on_error EXIT

bash scripts/compose.sh stop app
bash scripts/compose.sh exec -T postgres pg_dump -U silaut_owner -d silaut_demo -Fc > "$dump.part"
test -s "$dump.part"
bash scripts/compose.sh exec -T postgres pg_restore --file=/dev/null < "$dump.part"
mv "$dump.part" "$dump"
sha256sum "$dump" | tee "$evidence/cutover-dump.sha256"
sql() {
  bash scripts/compose.sh exec -T postgres psql -XAtq -v ON_ERROR_STOP=1 -U silaut_owner -d silaut_demo "$@"
}
sql < "$source_dir/scripts/v1-history.sql" > "$evidence/live-v1-before.json"

cd "$HOME/apps"
mv "$live" "$prior"
mv "$staging/silaut" "$live"
rmdir "$staging"
cd "$live"
docker image tag "$image" silaut-app:local
bash scripts/compose.sh up -d --wait postgres redis
db=$(bash scripts/compose.sh ps -q postgres)
mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$db")
[[ "$mount" == "$volume" ]]
[[ "$(sql -c "SELECT to_regclass('public.orders') IS NULL")" == t ]]
bash scripts/compose.sh exec -T postgres pg_restore -U silaut_owner -d silaut_demo \
  --no-owner --no-privileges --exit-on-error < "$dump"
bash scripts/compose.sh run --rm --no-deps bootstrap
sql < scripts/v1-history.sql > "$evidence/live-v1-after.json"
python3 scripts/compare-v1-history.py "$evidence/live-v1-before.json" "$evidence/live-v1-after.json" | tee "$evidence/live-history-check.json"
sql < scripts/verify-upgraded-history.sql | tee "$evidence/live-upgrade-check.json"
cmp <(sed -n '/^BASIC_AUTH_/p' "$prior/.env") <(sed -n '/^BASIC_AUTH_/p' .env)
SILAUT_VERIFIED_IMAGE_ID="$image" bash scripts/deploy.sh
[[ "$(docker inspect --format '{{.Image}}' "$(bash scripts/compose.sh ps -q app)")" == "$image" ]]
printf '%s\n' "$image $mount" | tee "$evidence/live-image-volume.txt"
bash scripts/compose.sh ps
trap - EXIT
