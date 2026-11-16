DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '003-workspace.sql') THEN
    RAISE EXCEPTION 'Workspace migration is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM orders o LEFT JOIN ticket_stations s ON (s.order_id, s.station) = (o.id, 'legacy')
      WHERE s.status IS DISTINCT FROM o.status
        OR s.status_updated_at IS DISTINCT FROM o.status_updated_at
        OR s.ready_at IS DISTINCT FROM CASE WHEN o.status = 'ready' THEN o.status_updated_at END) THEN
    RAISE EXCEPTION 'Legacy ticket station state changed';
  END IF;
  IF EXISTS (SELECT 1 FROM ingredients i LEFT JOIN inventory_movements m
      ON (m.ingredient_id, m.kind) = (i.id, 'opening')
      WHERE m.delta IS DISTINCT FROM i.on_hand OR m.balance_after IS DISTINCT FROM i.on_hand
        OR m.unit IS DISTINCT FROM i.unit)
    OR EXISTS (SELECT 1 FROM inventory_movements WHERE kind <> 'opening') THEN
    RAISE EXCEPTION 'Opening ledger does not match the migrated and seeded stock';
  END IF;
  IF (SELECT count(*) FROM menu_items WHERE archived_at IS NULL AND unavailable_reason IS NULL) <> 46
    OR (SELECT count(*) FROM menu_items WHERE id BETWEEN 1 AND 6 AND archived_at IS NOT NULL) <> 6
    OR EXISTS (SELECT 1 FROM menu_items WHERE archived_at IS NULL AND category = 'Salads') THEN
    RAISE EXCEPTION 'Active Buckhead catalog or legacy archive differs from the release fixture';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM menu_items alfredo JOIN menu_items cajun
      ON alfredo.price_cents = cajun.price_cents AND alfredo.modifier_groups = cajun.modifier_groups
      WHERE alfredo.id = 1010 AND cajun.id = 1012 AND cajun.price_cents = 1399
        AND cajun.archived_at IS NULL AND cajun.unavailable_reason IS NULL) THEN
    RAISE EXCEPTION 'Cajun Alfredo price or modifiers differ from regular Alfredo';
  END IF;
END $$;

SELECT jsonb_build_object(
  'openingMovements', (SELECT count(*) FROM inventory_movements WHERE kind = 'opening'),
  'legacyTickets', (SELECT count(*) FROM ticket_stations WHERE station = 'legacy'),
  'archivedV1Items', (SELECT count(*) FROM menu_items WHERE id BETWEEN 1 AND 6 AND archived_at IS NOT NULL),
  'sellableItems', (SELECT count(*) FROM menu_items WHERE archived_at IS NULL AND unavailable_reason IS NULL)
);
