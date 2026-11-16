import json
import sys
from pathlib import Path


before, after = (json.loads(Path(path).read_text()) for path in sys.argv[1:])
for key in ('orders', 'lines', 'migrations'):
    if before[key] != after[key]:
        sys.exit(f'Preserved history mismatch in {key}')

by_id = {ingredient['id']: ingredient for ingredient in after['stock']}
for ingredient in before['stock']:
    if by_id.get(ingredient['id']) != ingredient:
        sys.exit(f"Preserved stock mismatch for ingredient {ingredient['id']}")

ticket = next((order for order in before['orders'] if order['ticket_no'] == 101), None)
print(json.dumps({
    'ordersAndReceiptsPreserved': len(before['orders']),
    'linesPreserved': len(before['lines']),
    'ingredientBalancesPreserved': len(before['stock']),
    'v1MigrationChecksumsPreserved': len(before['migrations']),
    'ticket101': {key: ticket[key] for key in ('ticket_no', 'status', 'total_cents')} if ticket else None,
}, indent=2))
