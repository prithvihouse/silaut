ALTER TABLE ingredients ADD COLUMN unit text NOT NULL DEFAULT 'unit';
ALTER TABLE ingredients ADD COLUMN low_stock_threshold integer NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0);
ALTER TABLE menu_items ADD COLUMN category text NOT NULL DEFAULT 'Menu';
ALTER TABLE menu_items ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN cart_json jsonb;
ALTER TABLE orders ADD COLUMN receipt jsonb;
ALTER TABLE orders ADD COLUMN total_cents bigint;
ALTER TABLE orders ADD COLUMN ticket_no bigint GENERATED ALWAYS AS IDENTITY (START WITH 101);
ALTER TABLE orders ADD COLUMN status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready'));
ALTER TABLE orders ADD COLUMN status_updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX orders_ticket_number ON orders(ticket_no);
CREATE INDEX orders_kitchen ON orders(status,created_at);
CREATE TABLE order_items (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id integer NOT NULL REFERENCES menu_items(id),
  item_name text NOT NULL,
  quantity integer NOT NULL CHECK(quantity>0),
  unit_price_cents integer NOT NULL CHECK(unit_price_cents>=0),
  PRIMARY KEY(order_id,menu_item_id)
);
INSERT INTO order_items SELECT o.id,o.menu_item_id,m.name,o.quantity,o.unit_price_cents FROM orders o JOIN menu_items m ON m.id=o.menu_item_id;
UPDATE orders o SET cart_json=jsonb_build_array(jsonb_build_object('itemId',menu_item_id,'quantity',quantity)),
  total_cents=quantity::bigint*unit_price_cents,
  receipt=jsonb_build_object('orderId',o.id,'itemId',menu_item_id,'quantity',quantity,'unitPriceCents',unit_price_cents,
    'stockVersionAfter',stock_version_after::text,'sellableUnitsAfter',sellable_units_after,
    'ticketNumber',ticket_no,'createdAt',created_at,'totalCents',quantity::bigint*unit_price_cents,'currency','USD','paymentMode','simulated',
    'items',(SELECT jsonb_agg(jsonb_build_object('itemId',l.menu_item_id,'name',l.item_name,'quantity',l.quantity,
      'unitPriceCents',l.unit_price_cents,'lineTotalCents',l.quantity::bigint*l.unit_price_cents)) FROM order_items l WHERE l.order_id=o.id));
ALTER TABLE orders ALTER COLUMN cart_json SET NOT NULL;
CREATE TABLE app_settings (key text PRIMARY KEY,value text NOT NULL);
