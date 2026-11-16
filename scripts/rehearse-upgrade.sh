#!/usr/bin/env bash
# Restore a V1 custom archive into a throwaway local project and verify the V2 changes.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $# == 1 && -r "$1" ]] || { echo "Usage: bash scripts/rehearse-upgrade.sh /path/to/v1.dump" >&2; exit 1; }
dump=$1
scratch=$(mktemp -d)
suffix=$(openssl rand -hex 5)
project="silaut-upgrade-$suffix"
umask 077
printf 'TEST_DB_PASSWORD=%s\nTEST_APP_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$scratch/env"
cli=(docker compose --env-file "$scratch/env" -p "$project" -f deploy/compose.test.yaml)
trap '"${cli[@]}" down --volumes; rm -f -- "$scratch/env"; rmdir "$scratch"' EXIT
docker build -t silaut-app:local .
"${cli[@]}" up -d --wait postgres
"${cli[@]}" exec -T postgres createdb -U silaut_test_owner silaut_upgrade
"${cli[@]}" exec -T postgres pg_restore -U silaut_test_owner -d silaut_upgrade --no-owner --no-privileges --exit-on-error < "$dump"
"${cli[@]}" run --rm --no-deps -e PGDATABASE=silaut_upgrade tests node tests/rehearse-upgrade.cjs
