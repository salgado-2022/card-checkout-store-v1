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
- Timeout 10 s; 1 retry with backoff on timeout/5xx only.
- 4xx from provider → transaction ERROR (with reason), delivery CANCELLED, stock unchanged.
- Retry failure → transaction stays PENDING without external id; reconcile by reference. Never create a second charge with the same reference.

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

