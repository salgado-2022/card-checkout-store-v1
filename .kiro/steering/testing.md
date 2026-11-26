---
inclusion: fileMatch
fileMatchPattern: ["**/*.spec.ts", "**/*.test.ts", "**/*.test.tsx", "**/jest.config.*", "**/test/**"]
---
# Testing strategy (30 rubric points depend on this)

CI fails if any of statements/branches/functions/lines drops below **80%** in `api/` or `web/`. Aim for 90%.

| Layer | What | Tools | Target |
|---|---|---|---|
| api · domain | Money, amount calculation, status transitions, stock rules | plain Jest, no mocks | 100% |
| api · use cases | every Ok and every Err branch of the Result | Jest + in-memory fake ports | ≥95% |
| api · adapters | integrity signature with a known vector, event checksum, provider response/error mapping, DynamoDB repos | Jest + `aws-sdk-client-mock` + nock/msw | ≥85% |
| api · HTTP | invalid DTO → 400, each error code → its HTTP status, Idempotency-Key header | Jest + supertest on the Nest module | ≥85% |
| web · logic | Luhn, brand detection, field validators, COP and card formatters | Jest | 100% |
| web · state | reducers, selectors, thunks (success, error, polling, timeout), persistence middleware whitelist | Jest + msw | ≥95% |
| web · components | each screen and the modal: render, errors, disabled buttons, navigation | Jest + RTL + user-event | ≥85% |

## Must-have cases
- 4242 4242 4242 4242 → VISA valid; 5555 5555 5555 4444 → MasterCard; AMEX (37…) rejected by brand; Luhn failure rejected.
- Expiry in current month valid; previous month invalid.
- total = subtotal + baseFee + deliveryFee, integer cents (e.g. 120,000 × 2 + 3,000 + 8,000 = 251,000 COP).
- Insufficient stock → 409 and the UI message.
- Same Idempotency-Key twice → one transaction and one provider call; different body → 422.
- APPROVED decrements stock and assigns delivery; DECLINED/ERROR/VOIDED leave stock unchanged; repeated finalize never decrements twice.
- Webhook with bad signature → 401.
- Persisted state never contains card number or CVC.
- Refresh on status screen resumes polling without creating a new transaction.

## Rules
- Test behavior, not implementation details. No snapshot-only tests.
- No real network or AWS calls in unit tests.
- Never use real keys in fixtures: use obviously fake values like `pub_test_fake`.
