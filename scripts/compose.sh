#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo 'Run bash scripts/configure.sh first.' >&2; exit 1; }
source scripts/deploy-target.sh
mode=$(sed -n 's/^DEPLOY_MODE=//p' .env | tr -d "\r'\"")
if [[ "${SILAUT_DEPLOY_TARGET:-live}" == rehearsal && "$mode" != tunnel ]]; then
  echo 'The rehearsal requires DEPLOY_MODE=tunnel.' >&2
  exit 1
fi
export DEPLOY_MODE="$mode"
args=(--env-file .env -p "$SILAUT_COMPOSE_PROJECT" -f compose.yaml)
case "$mode" in
  public) args+=(-f deploy/compose.public.yaml);;
  tunnel) ;;
  *) echo 'DEPLOY_MODE must be tunnel or public in .env' >&2;exit 1;;
esac
if [[ "${SILAUT_DEPLOY_TARGET:-live}" == live ]]; then
  volume=$(sed -n 's/^SILAUT_LIVE_DB_VOLUME=//p' .env)
  if [[ -n "$volume" ]]; then
    [[ "$volume" =~ ^silaut-demo-v2-[a-z0-9]{8,32}-pg$ ]] || { echo 'Invalid live Postgres volume for promotion.' >&2; exit 1; }
    export SILAUT_LIVE_DB_VOLUME="$volume"
    args+=(-f deploy/compose.cutover-volume.yaml)
  fi
fi
exec docker compose "${args[@]}" "$@"
