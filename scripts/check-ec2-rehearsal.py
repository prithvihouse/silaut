import argparse
import base64
import csv
import http.client
import json
import re
import uuid
from pathlib import Path


parser = argparse.ArgumentParser(description='Verify a Silaut upgrade through its local SSH forward.')
parser.add_argument('rehearsal_id')
parser.add_argument('image_id')
parser.add_argument('login', type=Path, help='Owner-only file with a username and password on separate lines')
parser.add_argument('output', type=Path)
parser.add_argument('--port', type=int, default=18080)
args = parser.parse_args()
assert re.fullmatch('[a-z0-9]{8,32}', args.rehearsal_id)
assert re.fullmatch('sha256:[0-9a-f]{64}', args.image_id)
assert not args.login.stat().st_mode & 0o077, 'Rehearsal login file must be owner-only'
user, password = args.login.read_text().splitlines()
authorization = 'Basic ' + base64.b64encode(f'{user}:{password}'.encode()).decode()


def request(path, expected=200, *, payload=None, method='GET', auth=True):
    headers = {'Authorization': authorization} if auth else {}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    connection = http.client.HTTPConnection('127.0.0.1', args.port, timeout=30)
    try:
        connection.request(method, path, json.dumps(payload) if payload is not None else None, headers)
        response = connection.getresponse()
        body = response.read()
        content_type = response.getheader('Content-Type', '')
        assert response.status == expected, f'{method} {path}: expected {expected}, got {response.status} {body[:200]!r}'
        if expected == 401:
            assert response.getheader('WWW-Authenticate', '').startswith('Basic '), path
        if content_type.startswith('application/json'):
            body = json.loads(body)
        return body, content_type
    finally:
        connection.close()


def api(path, *args, **kwargs):
    return request('/api' + path, *args, **kwargs)[0]


def stock():
    return {i['id']: i for i in api('/stock')['ingredients']}


pages = ['/cashier', '/kitchen', '/inventory', '/sales', '/settings']
reads = ['/profile', '/catalog', '/tickets', '/stock', '/inventory/ingredients/1',
         '/settings/profile', '/sales/daily', '/shifts']
writes = [('POST', '/orders'), ('PATCH', '/tickets/' + str(uuid.uuid4()) + '/status'),
          ('POST', '/inventory/ingredients/1/movements'), ('PUT', '/settings/profile'),
          ('POST', '/shifts/open'), ('POST', '/shifts/' + str(uuid.uuid4()) + '/close')]
for page in pages:
    request(page, 401, auth=False)
    html, content_type = request(page)
    assert 'text/html' in content_type and b'<title>Silaut' in html, page
for route in reads:
    api(route, 401, auth=False)
    api(route)
for method, route in writes:
    api(route, 401, method=method, payload={}, auth=False)

profile = api('/profile')
assert profile['name'] == 'Bite More' and 'Buckhead' in profile['locationLabel']
catalog = {row['itemId']: row for row in api('/catalog')['items']}
assert len(catalog) == 46 and all(row['category'] != 'Salads' for row in catalog.values())
assert catalog[1012]['priceChannel'] == 'Owner-confirmed demo price'
assert catalog[1010]['priceCents'] == catalog[1012]['priceCents'] == 1399
assert catalog[1010]['modifierGroups'] == catalog[1012]['modifierGroups']
assert catalog[1001]['priceCents'] == 1499 and catalog[1040]['priceCents'] == 499

shift_id = str(uuid.uuid4())
assert api('/shifts')['active'] is None
opened = api('/shifts/open', 201, method='POST', payload={'shiftId': shift_id})
assert opened['id'] == shift_id
starting = stock()
order_id = str(uuid.uuid4())
burger = {'itemId': 1001, 'quantity': 1, 'modifiers': ['extra-patty', 'no-cheese', 'sauce-side']}
fries = {'itemId': 1040, 'quantity': 1}
receipt = api('/orders', 201, method='POST', payload={'orderId': order_id, 'items': [burger, fries]})
assert receipt['totalCents'] == 2297 and receipt['paymentMode'] == 'simulated'
assert receipt['orderId'] == order_id
ticket = receipt['ticketNumber']
assert [(line['itemId'], line['baseUnitPriceCents'], line['unitPriceCents']) for line in receipt['items']] == [
    (1001, 1499, 1798), (1040, 499, 499),
]
retry_items = [fries, {**burger, 'modifiers': list(reversed(burger['modifiers']))}]
assert api('/orders', method='POST', payload={'orderId': order_id, 'items': retry_items}) == receipt

stations = {'grill': burger['itemId'], 'fryer': fries['itemId']}
for station, item_id in stations.items():
    routed = next(row for row in api('/tickets?station=' + station)['tickets'] if row['orderId'] == order_id)
    assert routed['ticketNumber'] == ticket and routed['status'] == 'new'
    assert [line['itemId'] for line in routed['items']] == [item_id]
    if station == 'grill':
        assert {option['key'] for option in routed['items'][0]['modifiers']} == set(burger['modifiers'])
    api(f'/tickets/{order_id}/status', method='PATCH', payload={
        'station': station, 'expectedStatus': 'new', 'status': 'preparing',
    })
status_after_ready = {}
for station in stations:
    update = api(f'/tickets/{order_id}/status', method='PATCH', payload={
        'station': station, 'expectedStatus': 'preparing', 'status': 'ready',
    })
    status_after_ready[station] = update['orderStatus']
    assert bool(api(f'/orders/{order_id}')['readyAt']) == (station == 'fryer')
assert status_after_ready == {'grill': 'preparing', 'fryer': 'ready'}

deductions = {1: 3, 6: 200, 7: 2, 14: 1, 15: 25, 16: 35, 45: 6}
ending = stock()
changes = {idx: starting[idx]['onHand'] - row['onHand'] for idx, row in ending.items()}
assert {idx: delta for idx, delta in changes.items() if delta} == deductions
ledger = []
for idx, expected in deductions.items():
    movements = api(f'/inventory/ingredients/{idx}')['movements']
    matches = [row for row in movements if row['orderId'] == order_id]
    assert len(matches) == 1 and matches[0]['kind'] == 'sale'
    movement = matches[0]
    assert movement['delta'] == -expected and movement['balanceAfter'] == ending[idx]['onHand']
    assert str(movement['ticketNumber']) == str(ticket)
    assert movement['standardUnitCostMillicents'] is not None
    ledger.append({'ingredient': ending[idx]['name'], **{k: movement[k] for k in ('delta', 'unit', 'balanceAfter')}})
assert ending[3]['onHand'] == starting[3]['onHand']

close = api(f'/shifts/{shift_id}/close', method='POST', payload={})
assert api(f'/shifts/{shift_id}/close', method='POST', payload={}) == close
report = close['report']
assert (report['salesCents'], report['orderCount'], report['averageTicketCents']) == (2297, 1, 2297)
assert (report['readyOrderCount'], report['coveredOrders'], report['coveredSalesCents']) == (1, 1, 2297)
assert report['foodCostBasisPoints'] is not None and report['averageReadySeconds'] is not None
assert api('/shifts')['active'] is None
csv_path = f'/api/shifts/{shift_id}/report.csv'
request(csv_path, 401, auth=False)
exported, content_type = request(csv_path)
assert content_type.startswith('text/csv')
csv_rows = list(csv.reader(exported.decode().splitlines()))
assert ['Sales (cents)', '2297'] in csv_rows and ['Orders timed', '1'] in csv_rows
assert ['Orders with cost', '1'] in csv_rows
args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
(args.output / 'shift.csv').write_bytes(exported)
summary = {
    'pass': True,
    'rehearsalId': args.rehearsal_id,
    'imageId': args.image_id,
    'auth': {'pages': len(pages), 'apiReadsIncludingCsv': len(reads) + 1, 'apiWrites': len(writes)},
    'catalog': {'items': len(catalog), 'salads': 0, 'alfredoCents': 1399},
    'ticket': ticket,
    'totalCents': receipt['totalCents'],
    'stagesAfterReady': status_after_ready,
    'readyAt': api(f'/orders/{order_id}')['readyAt'],
    'equivalentOrderRetry': True,
    'saleLedger': ledger,
    'cheeseDeducted': 0,
    'shiftReport': report,
}
result = json.dumps(summary, indent=2) + '\n'
(args.output / 'workflow-check.json').write_text(result)
print(result, end='')
