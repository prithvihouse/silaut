#!/usr/bin/env bash
# Runs against an isolated, loopback-only Docker project with disposable credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
project="silaut-browser-$(openssl rand -hex 5)"
umask 077
user=silaut-qa
password=$(openssl rand -hex 18)
hash=$(printf '%s\n' "$password" | docker run --rm -i caddy:2.10.2-alpine caddy hash-password)
[[ "$hash" == '$2'* ]]
{
  printf 'POSTGRES_PASSWORD=%s\nPOS_APP_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)"
  printf "BASIC_AUTH_USER=%s\nBASIC_AUTH_HASH='%s'\nDEPLOY_MODE=tunnel\n" "$user" "$hash"
} > "$scratch/env"
cli=(docker compose --env-file "$scratch/env" -p "$project" -f compose.yaml)
trap '"${cli[@]}" down --volumes; rm -f -- "$scratch/env"; rmdir "$scratch"' EXIT
"${cli[@]}" build app
"${cli[@]}" up -d --wait postgres redis
"${cli[@]}" run --rm --no-deps bootstrap
"${cli[@]}" up -d --wait app caddy
SILAUT_BROWSER_USER="$user" SILAUT_BROWSER_PASSWORD="$password" SILAUT_BROWSER_BASE="http://127.0.0.1:8080" \
  SILAUT_BROWSER_PROJECT="$project" SILAUT_BROWSER_ENVFILE="$scratch/env" node tests/browser.cjs
