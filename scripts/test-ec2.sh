#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env.test ]];then
 umask 077
 printf 'TEST_DB_PASSWORD=%s\nTEST_APP_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env.test
fi
mkdir -p verification/v2
cli=(docker compose --env-file .env.test -p silaut-test -f deploy/compose.test.yaml)
docker build -t silaut-app:local .
trap '"${cli[@]}" down' EXIT
"${cli[@]}" up -d --wait postgres redis
"${cli[@]}" run --rm tests 2>&1 | tee verification/v2/integration-ec2.txt
