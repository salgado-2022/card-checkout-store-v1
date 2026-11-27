---
inclusion: fileMatch
fileMatchPattern: ["api/src/infrastructure/payment/**", "api/src/application/use-cases/**transaction**", "api/src/application/use-cases/**payment**", "web/src/features/checkout/**", "web/src/features/transaction/**"]
---
# Payment provider integration (Sandbox only)

Use the generic name `payment` everywhere. Base URL comes from `PAYMENT_API_URL` / `VITE_PAYMENT_API_URL` (confirmed in the spike).

## Keys
| Key | Where | Rule |
|---|---|---|
| Public (`pub_…`) | web (tokenize) + api (acceptance tokens) | only key allowed in the frontend bundle |
| Private (`prv_…`) | api only: create/get transactions | from SSM; never logged |
| Integrity secret | api only: transaction signature | from SSM |
| Events secret | api only: webhook checksum | from SSM |

## Flow
1. `GET /merchants/{publicKey}` → acceptance tokens + permalinks (privacy policy, personal data authorization). Exposed by our `GET /acceptance-tokens`.
2. Browser → `POST /tokens/cards` with the public key: `number`, `cvc`, `exp_month`, `exp_year`, `card_holder`. Keep only token id, brand and last four in memory. On 422 return to the card form with "Revisa los datos de tu tarjeta".
3. Our API → `POST /transactions` with the private key: `amount_in_cents`, `currency: "COP"`, `customer_email`, `reference`, `acceptance_token`, `accept_personal_auth`, `payment_method: { type: "CARD", token, installments }`, `signature`.
4. Our API → `GET /transactions/{externalId}` while PENDING (at most once per second per transaction).
5. Webhook `transaction.updated` → `POST /api/v1/webhooks/payments` (backup to polling).

## Signatures
- Integrity: `sha256hex(reference + amountInCents + currency + integritySecret)` — backend only.
- Event checksum: `sha256hex(values of signature.properties in order + timestamp + eventsSecret)`, compare with `signature.checksum` (or `X-Event-Checksum`) using `crypto.timingSafeEqual`. Mismatch → 401, no state change. Unknown reference → 200 + warning log.

## Resilience
Every provider call runs under one of two profiles of the Provider_Call_Policy. No request combines them: `POST /transactions` makes no lookup or status call, and `GET /transactions/:id` never sends a creation request.

| Profile | Used by | Timeout | Attempts |
|---|---|---|---|
| Standard_Profile | create transaction, acceptance tokens | 10 s per attempt | 1 retry after a 500 ms backoff, only on timeout or 5xx. Never on 4xx. |
| Single_Attempt_Profile | status by external id, lookup by Reference | 3 s | exactly 1, no retry. The web polling of `GET /transactions/:id` every 2 s is the retry. |

### Create outcomes (Standard_Profile)
- **4xx on the first attempt** → transaction ERROR (provider message as `statusReason`), delivery CANCELLED, stock unchanged, API answers 502 `PAYMENT_PROVIDER_ERROR`.
- **Timeout or 5xx on both attempts** → transaction stays PENDING without external id, delivery stays PENDING, API answers 201 with status PENDING.
- **Timeout or 5xx on the first attempt, then 4xx on the retry** → same as above: PENDING without external id, no reconciliation in this request, no further provider request, 201 with status PENDING.
- **Accepted with PENDING** → store the external id, 201 with status PENDING.
- **Accepted with a final status** → Amount_Check, then finalization, then 201 with the resulting status.
- Never create a second charge with the same reference. A creation request is never resent to resolve an unknown outcome.

### Reconciliation by Reference (Single_Attempt_Profile)
- Applies while a transaction is PENDING without external id. It runs only from `GET /transactions/:id`, never inline in `POST /transactions`.
- The lookup is read-only: it queries the provider by our Reference and never creates anything.
  - Found → store the external id and apply the provider status as in the status mapping below.
  - No record and the transaction is younger than the Reconciliation_Window of 60 s → stay PENDING, answer 200 with the stored state.
  - No record and the transaction is 60 s old or more → finalize as ERROR with reason `PROVIDER_UNREACHABLE`, delivery CANCELLED, stock unchanged.
  - Timeout or any HTTP error that does not mean "no record" → stay PENDING, answer 200 with the stored state, write a warning log. No second request in the same `GET`.

### Amount_Check (before any finalization)
Before a provider status is finalized (from the creation response, the status sync or the webhook), compare the provider `amount_in_cents`, `currency` and `reference` with the stored `totalInCents`, currency and Reference. Any difference finalizes the transaction as ERROR with reason `AMOUNT_MISMATCH`, delivery CANCELLED, stock unchanged, and writes an alert log entry. The provider status is not applied.

### Reconciliation lookup (assumption)
The lookup by Reference assumes a read-only, filterable transactions listing: `GET /transactions?reference=<reference>`. It returns the transaction created with that Reference, or an empty result when the provider has no record. Only `PaymentGatewayAdapter.findByReference` knows this wire shape. The application layer sees `found` (with external id and status) or `not_found`. If the real shape differs, only that adapter method changes. The observed Sandbox result is recorded in "Reference lookup (Sandbox result)" below.

## Status mapping
| Provider | Transaction | Delivery | Stock |
|---|---|---|---|
| APPROVED | APPROVED | ASSIGNED (or BACKORDER if no stock left + alert log) | decrement atomically |
| DECLINED / VOIDED / ERROR | same | CANCELLED | unchanged |

Finalization = one `TransactWriteItems`: transaction update conditioned on `status = PENDING`, delivery update, product update conditioned on `stock >= :qty`.

## Sandbox test cards
4242 4242 4242 4242 → APPROVED · 4111 1111 1111 1111 → DECLINED · any other Luhn-valid number → ERROR. Future expiry, 3-digit CVC.

## Reference lookup (Sandbox result)
Checked on 2026-11-27 with the private key against the Sandbox, before branch 3.
- Request: `GET {PAYMENT_API_URL}/transactions?reference=<reference>` with `Authorization: Bearer <private key>`.
- Not found: HTTP 200 with body `{"data":[],"meta":{}}`. An empty `data` array means `not_found`; it is not an error and is not retried.
- Found (checked on 2026-11-27 with the first transaction created through the API): HTTP 200, `data` is an array with one item. The item carries `id` (the External_Id), `status`, `status_message` (`null` when APPROVED), `reference`, `amount_in_cents`, `currency`, `created_at`, `finalized_at`, `customer_email`, `payment_method_type`, `payment_method` and other fields the API ignores. If several items come back, use the one whose `reference` matches exactly. `amount_in_cents`, `currency` and `reference` feed the Amount_Check.
- Without a key the provider answers HTTP 401 with `error.type` `INVALID_ACCESS_TOKEN`: map it to `REJECTED` (a configuration problem, never retried).

