---
inclusion: always
---
# Product

Single-product card checkout store (Colombia, COP) paid against a payment provider **Sandbox**. Technical assessment; deadline **Mon 2026-11-30 10:00 (America/Bogota)**.

## Five screens
1. Product (catalog + detail, quantity 1..min(stock, 5))
2. Card + delivery info (modal)
3. Summary (Material-style backdrop) → Pay
4. Final status (polling every 2 s, max 60 s)
5. Back to product with updated stock

## Scope
In: seeded catalog (3–6 products, no create/edit endpoint), one product per transaction, credit card only (VISA/MasterCard) with installments 1–36, customer + delivery capture, base fee + delivery fee, progress recovery on refresh, API for products/stock, customers, transactions, deliveries, AWS deployment with IaC.
Out: cart, coupons, taxes, auth/accounts, other payment methods, refunds, admin panel, real shipping.

## Product decisions (fixed — do not reopen)
- D1 Money: COP, integer cents everywhere.
- D2 Base fee 3,000 COP; D3 delivery fee 8,000 COP flat — both env-configurable.
- D4 Backend always computes amounts; frontend only displays.
- D5 Frontend tokenizes the card directly with the public key; backend only receives the token.
- D6/D7 Browser persistence: step, product, quantity, customer + delivery data, brand, last four, transaction id. Never card number, CVC or token. Refresh on step 2/3 asks again for number, expiry and CVC.
- D8 Final status via backend polling to the provider; webhook as backup.
- D9 Stock validated on create; decremented atomically only on APPROVED.
- D11 Customer document: type (CC, CE, NIT, PP) + number, required.
- D12 UI in Spanish; code, commits, branches, PRs and README in English.

## Scoring rubric (priority order)
Base (need 100/100): unit test coverage >80% front AND back (30) · full checkout flow approved + declined on deployed env (20) · API correct (20) · app + API deployed on AWS over HTTPS (20) · complete README (5) · fast images, no UI overflow from 375 px (5).
Bonus (safety net): hexagonal + ports & adapters (10) · ROP (10) · clean code with lint in CI (10) · CSS quality (10) · OWASP/HTTPS/headers (5) · responsive + multi-browser (5).

**Never cut:** 80% coverage on both sides, deployment, full flow, README.
**Cut first if late:** JWE card encryption → Playwright → automated deploy → webhook → extra visual polish.
