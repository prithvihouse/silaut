'use strict';

const assert = require('node:assert/strict');
const {promisify} = require('node:util');
const {execFile} = require('node:child_process');
const {mkdir, readFile} = require('node:fs/promises');
const {join} = require('node:path');
const {chromium, request} = require('playwright');
const sharp = require('sharp');

const execute = promisify(execFile);
const base = process.env.SILAUT_BROWSER_BASE;
const environment = process.env.SILAUT_BROWSER_ENVFILE;
const project = process.env.SILAUT_BROWSER_PROJECT;
const screenshots = process.env.SILAUT_BROWSER_SCREENSHOTS;
const auth = {username: process.env.SILAUT_BROWSER_USER, password: process.env.SILAUT_BROWSER_PASSWORD};
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !project?.startsWith('silaut-browser-') || !environment || !auth.password) {
  throw new Error('Use scripts/verify-browser.sh with an isolated loopback demo.');
}

async function responsive(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    name + ' has page-wide horizontal overflow');
}

async function capture(page, name) {
  if (!screenshots) return;
  await mkdir(screenshots, {recursive: true});
  await page.screenshot({path: join(screenshots, name + '.png')});
}

async function visible(locator) {
  await locator.waitFor({state: 'visible', timeout: 13000});
}

async function go(page, screen) {
  await page.getByRole('navigation', {name: 'Main navigation'}).getByRole('link', {name: screen, exact: true}).click();
  await visible(page.getByRole('heading', {level: 1, name: new RegExp('^' + screen)}));
  await responsive(page, screen);
}

async function main() {
  const anonymous = await request.newContext({baseURL: base});
  try {
    for (const path of ['/cashier', '/kitchen', '/inventory', '/sales', '/settings', '/api/catalog', '/api/tickets',
      '/api/profile', '/api/settings/profile', '/api/sales/daily', '/api/shifts', '/api/inventory/ingredients/1']) {
      const challenge = await anonymous.get(path);
      assert.equal(challenge.status(), 401, path);
      assert.match(challenge.headers()['www-authenticate'], /^Basic /);
    }
    for (const [method, path] of [['PUT', '/api/settings/profile'], ['POST', '/api/inventory/ingredients/1/movements'],
      ['POST', '/api/shifts/open']]) {
      const denied = await anonymous.fetch(path, {method, data: {}});
      assert.equal(denied.status(), 401, method + ' ' + path);
    }
    console.log('PASS Caddy Basic authentication covers all new screens and management APIs.');
  } finally { await anonymous.dispose(); }

  const authenticated = await request.newContext({baseURL: base, httpCredentials: {...auth, send: 'always'}});
  try {
    assert.equal((await authenticated.get('/settings')).status(), 200, 'Demo login opens Settings');
    assert.equal((await authenticated.get('/api/profile')).status(), 200, 'Demo login can read the profile');
  } finally { await authenticated.dispose(); }

  const browser = await chromium.launch({channel: process.env.SILAUT_BROWSER_CHANNEL || undefined});
  const problems = [];
  try {
    const tablet = await browser.newContext({baseURL: base, httpCredentials: auth, viewport: {width: 1024, height: 768}});
    const page = await tablet.newPage();
    page.on('pageerror', error => problems.push(error.message));
    const failedLoads = [];
    page.on('response', response => {
      if (response.status() >= 400) failedLoads.push([new URL(response.url()).pathname, response.status()]);
    });
    const settingsPage = await page.goto('/settings');
    assert.equal(settingsPage.status(), 200, 'Authenticated browser loads the Settings document');
    try { await visible(page.getByLabel('Restaurant name')); }
    catch (error) {
      console.error({title: await page.title(), errors: problems, failedLoads, body: (await page.locator('body').innerText()).slice(0, 500)});
      throw error;
    }
    await page.getByLabel('Restaurant name').fill('Bite More QA');
    await page.getByLabel('Location label').fill('Buckhead · Test counter');
    const png = await sharp({create: {width: 32, height: 32, channels: 3, background: '#1F5E4C'}}).png().toBuffer();
    await page.getByLabel(/Restaurant logo/).setInputFiles({name: 'demo-mark.png', mimeType: 'image/png', buffer: png});
    await page.getByRole('button', {name: 'Save settings'}).click();
    await visible(page.getByText('Restaurant profile saved.'));
    const cli = ['compose', '--env-file', environment, '-p', project, '-f', 'compose.yaml'];
    await execute('docker', [...cli, 'restart', 'app']);
    await execute('docker', [...cli, 'up', '-d', '--no-deps', '--wait', 'app']);
    await page.reload();
    await visible(page.locator('.workspace-restaurant').getByText('Bite More QA', {exact: true}));
    await page.waitForFunction(() => document.querySelector('.workspace-restaurant img')?.naturalWidth > 0);
    assert.equal(await page.getByLabel('Restaurant name').inputValue(), 'Bite More QA');
    assert.equal(await page.title(), 'Silaut · Settings');
    console.log('PASS Settings rename and raster logo survive an app restart and update the header.');

    await go(page, 'Sales');
    await visible(page.getByText('No committed orders on this service date.'));
    await page.getByRole('button', {name: 'Open shift'}).click();
    await visible(page.getByRole('button', {name: 'Close shift and save report'}));

    await go(page, 'Cashier');
    await page.getByRole('button', {name: 'Pasta', exact: true}).click();
    await visible(page.getByRole('button', {name: 'Customize Cajun Alfredo', exact: true}));
    assert.equal(await page.getByRole('button', {name: 'Salads', exact: true}).count(), 0);
    await page.getByRole('button', {name: 'All items', exact: true}).click();
    const search = page.getByRole('textbox', {name: 'Search menu'});
    await search.fill('Oklahoma');
    await page.getByRole('button', {name: 'Customize Oklahoma Onion Smash Burger'}).click();
    const editor = page.getByRole('dialog', {name: 'Oklahoma Onion Smash Burger'});
    await editor.getByRole('checkbox', {name: /Extra patty/}).check();
    await editor.getByRole('checkbox', {name: 'No cheese'}).check();
    await editor.getByRole('checkbox', {name: /Sauce on the side/}).check();
    await editor.getByRole('button', {name: /Add to order/}).click();
    await search.fill('Peri Peri');
    await page.getByRole('button', {name: 'Add Peri Peri Fries'}).click();
    const send = page.getByRole('button', {name: /Send to kitchen.*22\.97/});
    await visible(send);
    await page.reload();
    await visible(send);
    const menuBox = await page.locator('.menu-section').boundingBox();
    const orderBox = await page.getByRole('complementary', {name: 'Current order'}).boundingBox();
    assert.ok(orderBox.x >= menuBox.x + menuBox.width - 1);
    await search.fill('');
    await capture(page, 'cashier-tablet');
    await send.click();
    const receipt = page.locator('.desktop-cart .receipt-document');
    await visible(receipt.getByText(/Order #\d+ sent/));
    await visible(receipt.getByText('Bite More QA', {exact: true}));
    await visible(receipt.getByText('Powered by Silaut'));
    const sent = await receipt.getByText(/Order #\d+ sent/).textContent();
    const ticketNumber = sent.match(/#(\d+)/)[1];
    console.log('PASS Landscape cashier search, modifiers, reload, checkout and branded receipt (' + sent.trim() + ').');

    await go(page, 'Kitchen');
    await page.getByRole('button', {name: 'Grill', exact: true}).click();
    const ticket = page.getByRole('article', {name: 'Ticket #' + ticketNumber});
    await visible(ticket.locator('.ticket-items li').filter({hasText: 'Oklahoma Onion Smash Burger'}));
    await visible(ticket.getByText(/Extra patty.*No cheese/));
    assert.equal(await ticket.getByText('Peri Peri Fries', {exact: true}).count(), 0);
    await ticket.getByRole('button', {name: 'Start preparing Grill'}).click();
    await ticket.getByRole('button', {name: 'Mark ready Grill'}).click();
    await visible(ticket.getByText('Station complete'));
    await page.getByRole('button', {name: 'Fryer', exact: true}).click();
    await visible(ticket.getByText('Peri Peri Fries', {exact: true}));
    assert.equal(await ticket.locator('.ticket-items li').filter({hasText: 'Oklahoma Onion Smash Burger'}).count(), 0);
    await ticket.getByRole('button', {name: 'Start preparing Fryer'}).click();
    await ticket.getByRole('button', {name: 'Mark ready Fryer'}).click();
    await page.getByRole('button', {name: 'All Stations', exact: true}).click();
    await visible(page.getByRole('region', {name: 'Ready tickets'}).getByRole('article', {name: 'Ticket #' + ticketNumber}));
    await ticket.getByRole('button', {name: /View receipt/}).click();
    await visible(page.getByRole('dialog', {name: 'Receipt #' + ticketNumber}).getByText('Bite More QA', {exact: true}));
    await page.keyboard.press('Escape');
    console.log('PASS Kitchen filters isolate the two stations and the order becomes Ready after both finish.');

    await go(page, 'Inventory');
    await page.getByRole('textbox', {name: 'Search ingredients'}).fill('Beef patty');
    await page.getByRole('button', {name: 'Beef patty', exact: true}).click();
    const ingredient = page.getByRole('dialog', {name: 'Beef patty'});
    await visible(ingredient.getByText('Used 3 patties on ticket #' + ticketNumber, {exact: true}));
    await ingredient.getByLabel(/Quantity/).fill('10');
    await ingredient.getByLabel(/Delivery reference/).fill('QA delivery');
    await visible(ingredient.getByText('55 patties', {exact: true}));
    await ingredient.getByRole('button', {name: 'Confirm movement'}).click();
    await visible(ingredient.getByText('Received 10 patties', {exact: true}));
    await ingredient.getByLabel('Movement type').selectOption('waste');
    await ingredient.getByLabel(/Quantity/).fill('1');
    await ingredient.getByLabel('Reason').fill('QA prep');
    await ingredient.getByRole('button', {name: 'Confirm movement'}).click();
    await visible(ingredient.getByText('Wasted 1 patty', {exact: true}));
    await ingredient.getByLabel('Movement type').selectOption('count');
    await ingredient.getByLabel(/Actual count/).fill('52');
    await ingredient.getByRole('button', {name: 'Confirm movement'}).click();
    await visible(ingredient.getByText('Counted 52 patties', {exact: true}));
    await page.keyboard.press('Escape');
    console.log('PASS Inventory detail shows sale, projected receiving, waste, count and resulting history.');

    await go(page, 'Sales');
    await visible(page.locator('.daily-sales').getByText('$22.97', {exact: true}).first());
    await page.getByRole('button', {name: 'By sales'}).click();
    await page.getByRole('button', {name: 'Close shift and save report'}).click();
    const report = page.getByRole('region', {name: 'Closed shift report'});
    await visible(report.getByText('Beef patty', {exact: true}));
    await visible(report.getByText('1 completed order timed', {exact: true}));
    const downloadEvent = page.waitForEvent('download');
    await report.getByRole('link', {name: 'Export CSV'}).click();
    const download = await downloadEvent;
    assert.match(download.suggestedFilename(), /^silaut-shift-[0-9a-f-]+\.csv$/);
    const csv = await readFile(await download.path(), 'utf8');
    assert.match(csv, /"Sales \(cents\)","2297"/);
    assert.match(csv, /"Beef patty","1","patty","1"/);
    await page.emulateMedia({media: 'print'});
    assert.equal(await page.locator('.daily-sales').isVisible(), false);
    await visible(report);
    await capture(page, 'shift-report-print');
    await page.emulateMedia({media: 'screen'});
    console.log('PASS Sales, close-of-shift snapshot, CSV download and print layout.');

    const phone = await browser.newContext({baseURL: base, httpCredentials: auth, viewport: {width: 390, height: 844},
      isMobile: true, hasTouch: true, deviceScaleFactor: 1});
    const narrow = await phone.newPage();
    narrow.on('pageerror', error => problems.push(error.message));
    await narrow.goto('/cashier');
    await narrow.getByRole('textbox', {name: 'Search menu'}).fill('Classic Lemonade');
    await narrow.getByRole('button', {name: 'Add Classic Lemonade'}).tap();
    const summary = narrow.getByRole('button', {name: /View order.*3\.99/});
    await visible(summary);
    await responsive(narrow, 'Phone cashier');
    await summary.tap();
    const cart = narrow.getByRole('dialog', {name: 'Current order'});
    await visible(cart.getByText('Classic Lemonade'));
    await capture(narrow, 'cashier-phone');
    await narrow.keyboard.press('Escape');
    await cart.waitFor({state: 'hidden'});
    assert.equal(await summary.evaluate(button => button === document.activeElement), true);
    await summary.tap();
    await cart.getByRole('button', {name: /Send to kitchen/}).tap();
    await visible(narrow.locator('.cashier-mobile-receipt').getByText(/Order #\d+ sent/));
    await go(narrow, 'Inventory');
    await go(narrow, 'Kitchen');
    await go(narrow, 'Sales');
    await go(narrow, 'Settings');
    assert.deepEqual(problems, []);
    console.log('PASS 390 × 844 phone cart, Escape and focus return, checkout, and navigation without page overflow.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
