BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE menu_items (
    id integer PRIMARY KEY,
    name text NOT NULL,
    price_cents integer NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE ingredients (
    id integer PRIMARY KEY,
    name text NOT NULL,
    on_hand integer NOT NULL CHECK (on_hand >= 0),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE recipe_ingredients (
    menu_item_id integer REFERENCES menu_items(id),
    ingredient_id integer REFERENCES ingredients(id),
    units_per_item integer NOT NULL CHECK (units_per_item > 0),
    PRIMARY KEY (menu_item_id, ingredient_id)
);

CREATE INDEX recipe_ingredients_by_ingredient
    ON recipe_ingredients (ingredient_id, menu_item_id);

CREATE TABLE orders (
    id uuid PRIMARY KEY,
    menu_item_id integer NOT NULL REFERENCES menu_items(id),
    quantity integer NOT NULL CHECK (quantity > 0),
    unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    stock_version_after numeric CHECK (stock_version_after >= 0),
    sellable_units_after integer CHECK (sellable_units_after >= 0),
    CHECK ((stock_version_after IS NULL) = (sellable_units_after IS NULL))
);
COMMIT;
