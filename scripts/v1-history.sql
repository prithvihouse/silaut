SET TIME ZONE 'UTC';

SELECT jsonb_build_object(
  'orders', (SELECT coalesce(jsonb_agg(to_jsonb(prior) ORDER BY ticket_no), '[]')
    FROM (SELECT id, menu_item_id, quantity, unit_price_cents, created_at, stock_version_after,
        sellable_units_after, cart_json, receipt, total_cents, ticket_no, status, status_updated_at
      FROM orders) prior),
  'lines', (SELECT coalesce(jsonb_agg(to_jsonb(prior) ORDER BY order_id, menu_item_id), '[]')
    FROM (SELECT order_id, menu_item_id, item_name, quantity, unit_price_cents FROM order_items) prior),
  'stock', (SELECT coalesce(jsonb_agg(to_jsonb(prior) ORDER BY id), '[]')
    FROM (SELECT id, name, unit, on_hand, revision, low_stock_threshold FROM ingredients) prior),
  'migrations', (SELECT jsonb_agg(to_jsonb(prior) ORDER BY name)
    FROM (SELECT name, sha256, applied_at FROM schema_migrations
      WHERE name IN ('001-research-schema.sql', '002-silaut.sql')) prior)
);
