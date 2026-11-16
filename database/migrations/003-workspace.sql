CREATE TABLE restaurant_logos (
    digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
    png bytea NOT NULL CHECK (octet_length(png) BETWEEN 1 AND 262144)
);

CREATE TABLE restaurant_profile (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    location_label text NOT NULL CHECK (char_length(location_label) BETWEEN 1 AND 100),
    address text CHECK (char_length(address) BETWEEN 1 AND 240),
    logo_digest text REFERENCES restaurant_logos(digest),
    cutoff_minutes smallint NOT NULL DEFAULT 240 CHECK (cutoff_minutes BETWEEN 0 AND 1439)
);
INSERT INTO restaurant_profile (name, location_label, address)
VALUES ('Bite More', 'Buckhead · Atlanta, GA', '3150 Roswell Rd NW, Suite A1, Atlanta, GA 30305');

CREATE FUNCTION silaut_business_day(at_time timestamptz, cutoff integer)
RETURNS date LANGUAGE sql STABLE STRICT AS $$
    SELECT ((at_time AT TIME ZONE 'America/New_York') - make_interval(mins => cutoff))::date
$$;

CREATE TABLE shifts (
    id uuid PRIMARY KEY,
    opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    report jsonb,
    CHECK ((closed_at IS NULL) = (report IS NULL)),
    CHECK (closed_at >= opened_at)
);
CREATE UNIQUE INDEX shifts_one_open ON shifts ((true)) WHERE closed_at IS NULL;
CREATE INDEX shifts_recent ON shifts (opened_at DESC);

ALTER TABLE menu_items
    ADD COLUMN menu_key text UNIQUE,
    ADD COLUMN archived_at timestamptz,
    ADD COLUMN portion text,
    ADD COLUMN unavailable_reason text,
    ADD COLUMN station text NOT NULL DEFAULT 'legacy'
        CHECK (station IN ('legacy','grill','fryer','pasta','drinks','prep')),
    ADD COLUMN price_source_url text,
    ADD COLUMN price_channel text,
    ADD COLUMN price_checked_on date,
    ADD COLUMN modifier_groups jsonb NOT NULL DEFAULT '[]'
        CHECK (jsonb_typeof(modifier_groups) = 'array');

CREATE TABLE menu_modifier_ingredients (
    menu_item_id integer REFERENCES menu_items(id) ON DELETE CASCADE,
    ingredient_id integer REFERENCES ingredients(id),
    PRIMARY KEY (ingredient_id, menu_item_id)
);
CREATE INDEX menu_modifier_ingredients_by_item ON menu_modifier_ingredients (menu_item_id);

ALTER TABLE ingredients
    ADD COLUMN unit_cost_millicents integer CHECK (unit_cost_millicents >= 0),
    ADD COLUMN demo_assumption boolean NOT NULL DEFAULT false;

ALTER TABLE orders
    ADD COLUMN business_date date,
    ADD COLUMN ready_at timestamptz,
    ADD COLUMN food_cost_millicents numeric(26,0) CHECK (food_cost_millicents >= 0),
    ADD COLUMN shift_id uuid REFERENCES shifts(id),
    ADD COLUMN modifier_defaults jsonb NOT NULL DEFAULT '{}';
UPDATE orders SET business_date = silaut_business_day(created_at, 240),
    ready_at = CASE WHEN status = 'ready' THEN status_updated_at END;
ALTER TABLE orders ALTER COLUMN business_date SET NOT NULL;
CREATE INDEX orders_by_business_day ON orders (business_date);
CREATE INDEX orders_by_shift ON orders (shift_id) WHERE shift_id IS NOT NULL;

CREATE TABLE ticket_stations (
    order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
    station text CHECK (station IN ('legacy','grill','fryer','pasta','drinks','prep')),
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready')),
    status_updated_at timestamptz NOT NULL,
    preparing_at timestamptz,
    ready_at timestamptz,
    CHECK ((status = 'ready') = (ready_at IS NOT NULL)),
    PRIMARY KEY (order_id, station)
);
INSERT INTO ticket_stations (order_id, station, status, status_updated_at, preparing_at, ready_at)
SELECT id, 'legacy', status, status_updated_at,
    CASE WHEN status = 'preparing' THEN status_updated_at END, ready_at
FROM orders;
CREATE INDEX ticket_stations_board ON ticket_stations (station, status, status_updated_at DESC);

ALTER TABLE order_items ADD COLUMN line_no integer CHECK (line_no > 0),
    ADD COLUMN station text NOT NULL DEFAULT 'legacy',
    ADD COLUMN modifiers jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(modifiers) = 'array'),
    ADD COLUMN base_unit_price_cents integer CHECK (base_unit_price_cents >= 0);
WITH numbered AS (
    SELECT order_id, menu_item_id, row_number() OVER (PARTITION BY order_id ORDER BY menu_item_id) AS number
    FROM order_items
)
UPDATE order_items AS line SET line_no = numbered.number, base_unit_price_cents = line.unit_price_cents
FROM numbered WHERE (line.order_id, line.menu_item_id) = (numbered.order_id, numbered.menu_item_id);
ALTER TABLE order_items
    DROP CONSTRAINT order_items_pkey,
    ADD PRIMARY KEY (order_id, line_no),
    ALTER COLUMN base_unit_price_cents SET NOT NULL,
    ADD FOREIGN KEY (order_id, station) REFERENCES ticket_stations(order_id, station) ON DELETE CASCADE;

CREATE TABLE inventory_movements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ingredient_id integer NOT NULL REFERENCES ingredients(id),
    delta integer NOT NULL,
    unit text NOT NULL,
    balance_after integer NOT NULL CHECK (balance_after >= 0),
    kind text NOT NULL CHECK (kind IN ('opening','sale','receive','waste','count')),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    reason text,
    reference text,
    order_id uuid REFERENCES orders(id),
    shift_id uuid REFERENCES shifts(id),
    adjustment_id uuid UNIQUE,
    adjustment_request jsonb,
    purchase_cost_cents integer CHECK (purchase_cost_cents >= 0),
    standard_unit_cost_millicents integer CHECK (standard_unit_cost_millicents >= 0),
    CHECK ((order_id IS NOT NULL) = (kind = 'sale')),
    CHECK ((adjustment_id IS NOT NULL) = (kind IN ('receive','waste','count'))),
    CHECK ((adjustment_request IS NOT NULL) = (adjustment_id IS NOT NULL)),
    CHECK (purchase_cost_cents IS NULL OR kind = 'receive'),
    CHECK ((kind IN ('sale','waste') AND delta < 0) OR (kind = 'receive' AND delta > 0)
        OR (kind = 'opening' AND delta = balance_after) OR kind = 'count'),
    CHECK (kind <> 'waste' OR nullif(btrim(reason),'') IS NOT NULL)
);
CREATE UNIQUE INDEX inventory_opening_once ON inventory_movements (ingredient_id) WHERE kind = 'opening';
CREATE UNIQUE INDEX inventory_sale_once ON inventory_movements (order_id, ingredient_id) WHERE kind = 'sale';
CREATE INDEX inventory_history ON inventory_movements (ingredient_id, id DESC);
CREATE INDEX inventory_shift_waste ON inventory_movements (shift_id) WHERE kind = 'waste';
INSERT INTO inventory_movements (ingredient_id, delta, unit, balance_after, kind, reason)
SELECT id, on_hand, unit, on_hand, 'opening', 'Balance at v2 migration' FROM ingredients;
