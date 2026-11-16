# Silaut v2.0.0 verification

These results summarize the November 15, 2026 verification of the v2.0.0 release and deployed demo.

| Environment | Observed result |
| --- | --- |
| Isolated local PostgreSQL and Redis | **22 passed, 0 failed** across 3 normalization tests, 11 original integration tests, and 8 v2 integration tests. Coverage included atomic checkout, UUID replay and conflict, concurrent station and stock updates, inventory adjustments, and shift reporting. |
| Isolated compatibility and benchmark projects | The original API baseline and extended compatibility checks passed. The three-second k6 smoke run with two virtual users recorded 56 successful requests and zero contract failures. |
| Authenticated local browser | The five v2 screens, landscape cashier and phone layouts, branded receipt, station routing, inventory movements, and shift CSV and print views passed. The README screenshot shows a signed-in cashier with a demo cart. |
| EC2 upgrade rehearsal | A fresh v1 backup was restored in a separate project and upgraded using the deployment script and a native Linux image. The final fixture exposed 46 items, including matching Alfredo prices and modifiers, with salads removed. The rehearsal preserved 3 historical orders and receipts, 6 order lines, and 13 stock balances and revisions. |
| EC2 workflow through SSH | A modified Oklahoma Onion Smash Burger and Peri Peri Fries totaled **$22.97**. The UUID retry returned the identical receipt and posted no additional movements. The seven sale deductions included 3 beef patties and zero cheese. The order became Ready after both Grill and Fryer finished, and the single-order shift exported successfully as CSV. |
| Production cutover | The same verified image was promoted. The preserved history and stock comparison passed again. HTTP redirected to HTTPS, the certificate validated, and all 16 unauthenticated page and API probes returned 401. Authenticated browser sign-in and all five v2 workspace tabs were verified. |

To run the local checks, follow [Test commands](../README.md#test-commands). To rehearse or deploy on your own instance, see the [EC2 guide](AWS_DEPLOYMENT.md).
