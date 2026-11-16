#!/usr/bin/env bash
set -euo pipefail
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password POS_APP_PASSWORD
CREATE ROLE pos_app LOGIN PASSWORD :'app_password';
SQL
