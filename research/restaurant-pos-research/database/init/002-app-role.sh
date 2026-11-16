#!/usr/bin/env bash
(
    set -eu
    psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password POS_APP_PASSWORD
BEGIN;
CREATE ROLE pos_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE pos TO pos_app;
GRANT USAGE ON SCHEMA public TO pos_app;
GRANT SELECT ON menu_items, ingredients, recipe_ingredients, orders TO pos_app;
GRANT UPDATE (on_hand, revision) ON ingredients TO pos_app;
GRANT INSERT ON orders TO pos_app;
GRANT UPDATE (stock_version_after, sellable_units_after) ON orders TO pos_app;
COMMIT;
SQL
)
