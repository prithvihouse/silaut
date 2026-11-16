# Silaut v2 browser acceptance

Use an isolated demo if making test orders, changing the profile, adjusting stock, or closing a shift. `bash scripts/verify-browser.sh` exercises this flow against loopback Caddy using a disposable login and database. [Verification summary](VERIFICATION.md)

1. In **Settings**, rename the restaurant and select a small PNG. Save. Restart the app, then check the name, location, and logo in the header. After checkout, check the receipt identity. Rename again and view the earlier receipt from Kitchen.
2. On a 1024 × 768 landscape display, **Cashier** keeps the cart beside the menu. Search the menu and filter by category. Add the **Oklahoma Onion Smash Burger** with **Extra patty** and **No cheese**, then **Peri Peri Fries**. Expect **$22.97**. Reload before submission to confirm the cart persists. Submit once and confirm the receipt and empty cart.
3. In **Kitchen**, Grill sees the burger and its modifiers. Fryer sees the fries. Advance one station to Ready and confirm the overall order is still Preparing. Advance the other station and confirm the same order number is Ready under All Stations.
4. In **Inventory**, open Beef patty. The order used three patties. Review Receiving, Waste, and Count correction. Confirm that projected balances, committed movements, and history agree. Check the sale entry's ticket reference.
5. In **Sales**, view an unused service date. Open a shift before checkout. Close after finishing the stations and recording waste. Check total sales, completed order count for Time to Ready, covered food cost, waste, CSV export, and print view.
6. On a 390 × 844 phone viewport, inspect all five screens. Open the cart, press Escape, and verify focus returns to View order. Submit a small simulated order and confirm the compact receipt. Check that the page has no horizontal overflow.
7. In a fresh unauthenticated session, check `/settings`, `/sales`, and their APIs, as well as `/cashier` and `/api/stock`. Each route should challenge for the existing password. For public deployment, check the HTTP redirect and use normal HTTPS certificate validation.
