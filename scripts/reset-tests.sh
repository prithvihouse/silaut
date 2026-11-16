#!/usr/bin/env bash
# Only the disposable test project is reset. No arguments or project overrides accepted.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ $# == 0 ]] || { echo 'This command takes no arguments.';exit 1; }
[[ -f .env.test ]] || { echo 'No test environment exists yet.';exit 0; }
docker compose --env-file .env.test -p silaut-test -f deploy/compose.test.yaml down --volumes --remove-orphans
echo 'Reset only silaut-test: its test database and cache. Hosted demo and research data were untouched.'
