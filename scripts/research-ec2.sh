#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env.research ]];then
 umask 077
 printf 'POSTGRES_PASSWORD=%s\nPOS_APP_PASSWORD=%s\nCACHE_MODE=postgres\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env.research
fi
export SILAUT_ROOT="$PWD" SILAUT_UID="$(id -u)" SILAUT_GID="$(id -g)" SILAUT_BENCH_SEED="$(date +%s)"
export SILAUT_VERIFICATION_DIR="$PWD/verification/v2"
mkdir -p "$SILAUT_VERIFICATION_DIR"
base=(docker compose --env-file "$PWD/.env.research" -p silaut-baseline -f research/restaurant-pos-research/compose.yaml -f deploy/compose.baseline.yaml)
research=(docker compose --env-file .env.research -p silaut-research -f deploy/compose.research.yaml)
trap '"${base[@]}" down; "${research[@]}" down' EXIT
docker build -t silaut-app:local .
# Original services, schema, seed, API code, lockfile, and Dockerfile.
"${base[@]}" up -d --wait postgres redis
count=$("${base[@]}" exec -T postgres psql -U pos_admin -d pos -Atc 'SELECT count(*) FROM menu_items')
if [[ "$count" == 0 ]];then
 "${base[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U pos_admin -d pos < research/restaurant-pos-research/database/seed.sql
fi
"${base[@]}" up -d --build --wait api
"${base[@]}" run --rm --no-deps verifier | tee "$SILAUT_VERIFICATION_DIR/baseline-ec2.json"
"${base[@]}" down
# Extended backend with the unchanged research fixture, separate database and volume.
"${research[@]}" up -d --wait postgres redis
"${research[@]}" run --rm --no-deps bootstrap
count=$("${research[@]}" exec -T postgres psql -U research_owner -d silaut_research -Atc 'SELECT count(*) FROM menu_items')
if [[ "$count" == 0 ]];then
 "${research[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U research_owner -d silaut_research < research/restaurant-pos-research/database/seed.sql
fi
"${research[@]}" up -d --wait api
"${research[@]}" run --rm --no-deps verifier | tee "$SILAUT_VERIFICATION_DIR/compatibility-ec2.json"
"${research[@]}" run --rm --no-deps benchmark 2>&1 | tee "$SILAUT_VERIFICATION_DIR/benchmark-ec2.txt"
"${research[@]}" run --rm --no-deps verifier node tests/check-benchmark.cjs /verification/benchmark-ec2.ndjson | tee "$SILAUT_VERIFICATION_DIR/benchmark-contract-ec2.json"
echo 'Original baseline and compatibility benchmark passed in isolated projects.'
