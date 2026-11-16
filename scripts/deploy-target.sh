# Shared by compose.sh and deploy.sh. Source from the project directory.
case "${SILAUT_DEPLOY_TARGET:-live}" in
  live)
    SILAUT_COMPOSE_PROJECT=silaut-demo
    SILAUT_DB_NAME=silaut_demo
    SILAUT_LOOPBACK_PORT=8080
    SILAUT_APP_IMAGE=silaut-app:local
    ;;
  rehearsal)
    if [[ ! "${SILAUT_REHEARSAL_ID:-}" =~ ^[a-z0-9]{8,32}$ ]]; then
      echo 'Set SILAUT_REHEARSAL_ID to an 8–32 character lowercase alphanumeric value.' >&2
      exit 1
    fi
    SILAUT_COMPOSE_PROJECT="silaut-rehearsal-$SILAUT_REHEARSAL_ID"
    SILAUT_DB_NAME=silaut_rehearsal
    SILAUT_LOOPBACK_PORT=18080
    SILAUT_APP_IMAGE="silaut-app:rehearsal-$SILAUT_REHEARSAL_ID"
    ;;
  *)
    echo 'SILAUT_DEPLOY_TARGET must be live or rehearsal.' >&2
    exit 1
    ;;
esac
export SILAUT_COMPOSE_PROJECT SILAUT_DB_NAME SILAUT_LOOPBACK_PORT SILAUT_APP_IMAGE
