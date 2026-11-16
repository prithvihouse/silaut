# Bite More Buckhead menu import

The checked-in fixture uses **Buckhead online pickup** prices checked November 15, 2026 (Eastern time), with an owner-confirmed demo price for Cajun Alfredo. The ordering page displayed Pickup selected and **3150 Roswell Rd NW, Suite A1, Atlanta, GA 30305**. The importer uses the fixture offline. [Buckhead pickup listing](https://order.online/business/13060526/store/bite-more-roswell-rd-30601156?pickup=true) · [Buckhead location](https://bitemore.us/buckhead) · [Restaurant menu](https://bitemore.us/menu)

Use the prices shown in the primary pickup listing before checkout promotions. The restaurant pages cross-check names, categories, and location. A current Buckhead in-store export can be used for a future pricing update with its own channel and provenance. [Pickup listing](https://order.online/business/13060526/store/bite-more-roswell-rd-30601156?pickup=true)

## Imported counts

| Category | Sellable | Unavailable |
|---|---:|---:|
| Burgers | 4 | 0 |
| Specials | 1 | 0 |
| Birria | 2 | 0 |
| Pasta | 3 | 0 |
| Chicken | 4 | 0 |
| Wings | 2 | 0 |
| Fries & Sides | 5 | 0 |
| Meals | 2 | 0 |
| Desserts | 4 | 0 |
| Lemonades | 4 | 0 |
| Drinks | 6 | 0 |
| Sauces | 9 | 0 |
| **Total** | **46** | **0** |

The 46 unique rows on the pickup listing include Cajun Alfredo. The owner confirmed that Buckhead no longer sells salads, so the fixture omits them. Featured and Most Ordered repeat items from the main categories. Mac Attack Fries also appeared under Meals and Appetizers and is imported once. Six- and ten-piece wings, six-piece tenders, and the wing and chicken meals with fries have distinct IDs. Named portions reflect the listing where stated. Quantities in recipes are sample assumptions. [Pickup listing](https://order.online/business/13060526/store/bite-more-roswell-rd-30601156?pickup=true) · [Restaurant menu](https://bitemore.us/menu)

### Price checks

| Item | Regular pickup | Cross-check |
|---|---:|---|
| Oklahoma Onion Smash Burger | $14.99 | The pickup item detail independently displayed $14.99. It listed Extra Patty at +$2.99, No American Cheese without a surcharge, fries at +$3.99, and Garlic Parmesan Fries at +$5.99. |
| Alfredo Pasta | $13.99 | The same-address marketplace listing and the merchant's alternate storefront displayed $13.99. |
| Peri Peri Fries | $4.99 | The same-address marketplace listing and the merchant's alternate storefront displayed $4.99. |
| 6pcs Chicken Wings | $9.99 | The same-address marketplace listing displayed $9.99. DoorDash also displayed $9.99 as the regular price on a promotional card. |

[Pickup listing](https://order.online/business/13060526/store/bite-more-roswell-rd-30601156?pickup=true) · [Merchant storefront](https://order.online/store/bite-more-roswell-rd-30601156) · [Same-address marketplace listing](https://www.ubereats.com/store/bite-more/TzKEa1M1VC-jtWYbSf1RlA)

Cajun Alfredo is $13.99 at the owner's direction and shares Alfredo Pasta's modifier choices and prices. Its source channel is “Owner-confirmed demo price” with a November 15, 2026 verification date.

### Unresolved entries and options

| Entry | Treatment |
|---|---|
| Pasta names in the restaurant overview | Cajun Chicken Alfredo Fettuccine, Pomodoro, Arrabbiata, Spicy Vodka Shrimp Rigatoni, Spicy Vodka Pasta, Sicilian Pesto Salmon Fettuccine, and Truffle Mushroom dishes did not appear as distinct priced rows on the selected pickup page. The priced Spicy Vodka Rigatoni row is available. |
| Other site or alternate-snapshot entries | Signature Smash Burger, Hot Nashville Fries, Birria Fries, Blue Raspberry Lemonade, and other site-only entries with no current Buckhead pickup row remain outside checkout. The Duluth menu and delivery promotions were excluded. |
| Additional portions and options | The base Mac N Cheese side is $5.99. Half-pan and full-pan prices, alternate tender counts, merchant wing flavor charges, protein choices on the other pasta dishes, and unsupported add-on combinations remain unavailable as merchant choices. |
| Demo options | The plain, BBQ, and Buffalo wing choices exercise the required editor at demo pricing. The optional chicken choice on both Alfredos and the Sauce on the side instruction are labeled Demo option. Sauce on the side leaves the base sauce deduction intact. |

Verified Oklahoma toppings, protein additions, and removals are available with their observed pickup surcharges. The listing’s “No Bun” control was ambiguous, so that control is omitted. Recommended beverages, desserts, and sides are available as their own catalog lines where verified. [Pickup listing](https://order.online/business/13060526/store/bite-more-roswell-rd-30601156?pickup=true) · [Restaurant menu](https://bitemore.us/menu) · [Alternate storefront snapshot](https://order.online/store/bite-more-30601156)

## Validation and import

```bash
npm run menu:import -- --check
npm run migrate
npm run menu:import
# Use current PG* values for the intended demo database.
# Import an updated, reviewed fixture as the database owner:
npm run menu:import -- ./database/seeds/buckhead.json
```

The fixture includes stable numeric IDs and merchant keys, names, original descriptions, categories, stations, price cents, portions when known, recipe quantities, and modifier configuration. Each imported row records the source URL, price channel, and date from its own entry or the fixture's default. The importer validates IDs, names, prices, source metadata, recipes, ingredient references, selection limits, and modifier deductions before writing.

First import archives the original six IDs and seeds new ingredients with sample opening balances. A rerun updates catalog definitions and archives removed Buckhead rows. Keep each ID and key paired on future imports. Existing ingredient balances, cost edits, order lines, receipts, and ticket history are preserved. Old receipt retries can still replay. The original fixture remains in [demo.json](../database/seeds/demo.json) for regressions.

Edit [buckhead.json](../database/seeds/buckhead.json) for recipe quantities, portions, thresholds, new ingredient opening quantities, and future catalog options. Edit an existing ingredient's standard cost in Inventory. Receiving purchase cost stays with the movement. All stock, estimated standard costs, and recipe quantities represent fictional demo inputs.
