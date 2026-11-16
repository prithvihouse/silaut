# Silaut v2 architecture

## Application and access

Express serves the built React application at `/cashier`, `/kitchen`, `/inventory`, `/sales`, and `/settings`. Caddy applies the existing Basic authentication to all pages, API routes, images, and CSV exports. The app, database, and cache share an internal Compose network. Only Caddy publishes service ports. Mutation requests use JSON and pass the same-origin check. Checkout keeps its original 8 KiB request limit. Settings has a separate bounded request limit for image upload.

The workspace has one PostgreSQL profile with a configurable Eastern cutoff. Raster uploads are limited to 256 KiB and 1,024 pixels per side. The server decodes and re-encodes one PNG, JPEG, or WebP image into a PNG at up to 192 pixels per side. Content-addressed logos remain available to old receipts. New receipts store the name, location, address and logo reference they used. The kitchen receipt viewer displays the original Silaut identity for receipts without a restaurant snapshot.

## Checkout and fulfillment

```json
{
  "orderId": "78cfc182-142a-4cf3-94e1-1a46fb57ce5c",
  "items": [
    {"itemId": 1001, "quantity": 1, "modifiers": ["extra-patty", "no-cheese"]},
    {"itemId": 1040, "quantity": 1}
  ]
}
```

Checkout accepts legacy single-item requests with `orderId`, `itemId`, and `quantity`. Single-line receipts retain `itemId`, `quantity`, `unitPriceCents`, `stockVersionAfter`, and `sellableUnitsAfter` for the benchmark. New lines snapshot base and charged prices, configuration, and station. Each UUID is serialized in PostgreSQL. The server compares the entire canonical cart and uses saved defaults to resolve retries after a catalog change. Identical configurations merge. Different configurations get separate line numbers. A matching replay returns 200 and the original receipt. A changed configuration returns 409.

New sales validate availability, each group's selection limits, and the chosen options. The server computes price deltas separately from signed recipe deltas. Kitchen-only instructions can leave both amounts unchanged. All ingredient requirements are combined and locked in ascending ingredient ID order. A sale writes the receipt, charges, station work, inventory deductions, and cost snapshots in one transaction. Any shortage rejects the entire cart. The client retains the pending cart and UUID after an uncertain response.

Each ticket has one row per station. A station moves New → Preparing → Ready. Compare-and-set requests and a parent order lock make simultaneous updates safe. Each step records its own timestamp. The order's Ready timestamp records when the last station completed. Migration places older tickets in Legacy with their existing status and known timestamps.

## Inventory and reporting

The runtime role can read and append inventory movements. Every movement includes the signed delta, unit, timestamp and resulting balance. Sales link to orders and save the standard unit costs used at checkout. Receiving, waste, and count corrections use UUIDs to replay safely. Manual changes use the same stock locks as checkout. The UI includes the observed stock revision with count confirmations to detect an intervening change. Opening events for existing stock capture a single migration boundary. The migration performs no reconstruction of earlier movements or costs.

The four original Redis modes remain. The v2 catalog calculates availability for default configurations in one database query. The legacy item endpoint uses the original cache behavior. Invalidating modes invalidate keys for applicable base recipes and modifiers after inventory commits. The fenced mode retains its guard against old in-flight fills. The TTL-only research mode retains its expiry-only behavior. A failed cache invalidation can leave the legacy endpoint stale until TTL expiry.

Daily reports use each committed order's persisted Eastern service date. The estimate uses exact integer units and integer thousandths of a cent. SQL sums costs before rounding. A closed shift stores the metrics and waste in a report snapshot. Checkout, adjustments, and station transitions coordinate with shift open and close via a PostgreSQL advisory lock. Repeated close requests return the stored report.

## API entry points

| Route | Purpose |
|---|---|
| `GET /healthz`, `GET /metrics` | Readiness and cache metrics |
| `GET /menu`, `GET /menu/items/:id` | Original API and item availability contract |
| `GET /api/catalog` | Catalog metadata, availability, modifier groups, and price provenance |
| `POST /api/orders`, `GET /api/orders/:id` | Checkout and stored receipt |
| `GET /api/tickets?station=grill`, `PATCH /api/tickets/:id/status` | Station board and transition with `station`, `expectedStatus`, `status` |
| `GET /api/profile`, `PUT /api/settings/profile`, `GET /api/logos/:digest` | Restaurant profile and raster logo |
| `GET /api/stock`, `GET /api/inventory/ingredients/:id` | Balances and paginated ingredient history |
| `POST /api/inventory/ingredients/:id/movements` | Record receiving, waste, or an actual count with an adjustment UUID |
| `PATCH /api/inventory/ingredients/:id/cost` | Sample standard unit cost in thousandths of a cent |
| `GET /api/sales/daily?date=YYYY-MM-DD` | Daily sales and coverage |
| `GET /api/shifts`, `POST /api/shifts/open`, `POST /api/shifts/:id/close` | Shift operations and report snapshots |
| `GET /api/shifts/:id/report.csv` | CSV export of the frozen report |

## Data isolation

Migrations 001 and 002 keep their original checksums. The v2 migration adds profile, station, inventory, and reporting structures while preserving existing receipt JSON and stock revisions. Bootstrap imports Buckhead only into the demo. Research and acceptance tests use their own projects, databases, volumes, and Redis instances. Verification of the extended backend uses the included research schema, demo catalog, and k6 scenario. [Menu import](MENU_IMPORT.md)
