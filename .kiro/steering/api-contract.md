---
inclusion: fileMatch
fileMatchPattern: ["api/src/infrastructure/http/**", "web/src/shared/api/**", "docs/**postman**"]
---
# API contract (`/api/v1`, JSON, camelCase, integer cents, ULID ids)

| Method | Path | Responses |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/products` | 200, 429 |
| GET | `/products/:id` | 200, 404, 429 |
| GET | `/fees` | 200, 429 |
| GET | `/acceptance-tokens` | 200, 429, 502 |
| POST | `/customers` (upsert by email) | 201, 200, 400, 415, 429 |
| GET | `/customers/:id` | 200, 404, 429 |
| POST | `/transactions` (requires `Idempotency-Key`) | 201, 200 (idempotent replay), 400, 404, 409, 415, 422, 429, 502 |
| GET | `/transactions/:id` (syncs with provider if PENDING) | 200, 404, 429 |
| GET | `/deliveries/:id` | 200, 404, 429 |
| POST | `/webhooks/payments` (optional, available only after branch 6 merges) | 200, 401, 415, 429 |

Every route, `GET /health` included, answers 403 `FORBIDDEN_ORIGIN` when `X-Origin-Verify` is missing or wrong (CloudFront always adds it). Every route except `GET /health` can also answer 500 `INTERNAL_ERROR`. Any `POST` with a body can also answer 413 `PAYLOAD_TOO_LARGE`. Any unknown route answers 404 `ROUTE_NOT_FOUND`.

## Request rules
- **Content type.** A `POST` accepts `application/json` with or without `charset=utf-8` (any letter case). A missing `Content-Type`, any other media type or any other charset answers 415 `UNSUPPORTED_MEDIA_TYPE`.
- **Amounts.** The API reads no client-sent amount. A body with an amount property (for example `amountInCents` or `totalInCents`) is rejected with 400 `VALIDATION_ERROR` by `whitelist` + `forbidNonWhitelisted`. The same rule rejects any other unknown property.
- **Idempotency.** `POST /transactions` requires `Idempotency-Key`: 8 to 128 characters from letters, digits, `.`, `_` and `-`. Missing or empty → 400 `MISSING_IDEMPOTENCY_KEY`; wrong format → 400 `VALIDATION_ERROR`.
  - Same key and same body after the first request finished → 200 with the stored response, no new transaction, no provider call.
  - Same key and a different body → 422 `IDEMPOTENCY_KEY_REUSED`.
  - Same key and same body while the first request is still running → 409 `IDEMPOTENCY_KEY_IN_PROGRESS`.
  - Records expire after 24 h. If the request fails with a business error before the transaction is written, the key can be used again.

## `POST /transactions`
Body: `productId`, `quantity` (1..5), `customerId`, `delivery { recipientName, phone, addressLine1, addressLine2?, city, department, postalCode? }`, `payment { cardToken, installments, brand, lastFour }`, `acceptanceToken`, `acceptPersonalAuth`. The backend computes every amount.

Response 201 (and 200 on replay): `id`, `reference` (`ORD-<ULID>`), `status`, `amounts { currency, subtotalInCents, baseFeeInCents, deliveryFeeInCents, totalInCents }`, `deliveryId`, `card { brand, lastFour }`, `createdAt`. The response never includes the card token.

| Provider outcome | Result |
|---|---|
| Accepted with status PENDING | 201, status PENDING |
| Accepted with a final status | Amount check, then finalization; 201 with the resulting status |
| Timeout or 5xx on both attempts (first try and the one retry) | 201, status PENDING, no provider id stored |
| Timeout or 5xx on the first attempt, then Provider 4xx on the retry | 201, status PENDING, no provider id stored |
| Provider 4xx on the first creation attempt | Transaction ERROR, delivery CANCELLED, stock unchanged, 502 `PAYMENT_PROVIDER_ERROR` |

- 201, status PENDING without a provider id means the charge outcome is unknown. The create request never reconciles inline and never sends a second creation request.
- `GET /transactions/:id` reconciles later by `reference` with a read-only lookup, one attempt, 3 s timeout. It never creates a second charge.
- If the provider has no record of the reference 60 s after creation, the transaction becomes ERROR with `statusReason` `PROVIDER_UNREACHABLE`.
- 502 `PAYMENT_PROVIDER_ERROR` on `POST /transactions` means a Provider 4xx on the first creation attempt. It is never returned for timeouts or 5xx.

## Response shapes
`GET /acceptance-tokens` (200): `{ acceptanceToken: { token, permalink }, acceptPersonalAuth: { token, permalink } }`. The web app sends `acceptanceToken.token` as `acceptanceToken` and `acceptPersonalAuth.token` as `acceptPersonalAuth` in `POST /transactions`. 502 `PAYMENT_PROVIDER_ERROR` if the provider cannot be reached.

`GET /fees` (200): `currency`, `baseFeeInCents`, `deliveryFeeInCents`. Values come from `BASE_FEE_IN_CENTS` and `DELIVERY_FEE_IN_CENTS`.

`GET /products` (200): array of items with `id`, `sku`, `name`, `description`, `imageUrl`, `priceInCents`, `currency`, `stock`. `GET /products/:id` (200) returns one item of the same shape. `imageUrl` is a path served by the web app (for example `/images/sku-001.webp`). `priceInCents` is an integer.

`GET /transactions/:id` (200): `id`, `reference`, `status`, `statusReason?`, `amounts`, `deliveryId`, `card { brand, lastFour }`, `productId`, `quantity`, `installments`, `createdAt`, `updatedAt`, `finalizedAt?`.

## `statusReason` values
`statusReason` appears only on a final status that carries a reason.

| Value | Status | Meaning |
|---|---|---|
| `PROVIDER_UNREACHABLE` | ERROR | The creation request never reached the provider, and a lookup by `reference` found no record 60 s after creation. Delivery CANCELLED, stock unchanged. |
| `AMOUNT_MISMATCH` | ERROR | The amount, currency or reference reported by the provider differs from the stored transaction. Delivery CANCELLED, stock unchanged, alert log entry. |
| Provider message (free text) | DECLINED, VOIDED, ERROR | Message returned by the provider, or by a Provider 4xx on creation. |

## Error format (all 4xx/5xx)
`{ "statusCode": 409, "code": "INSUFFICIENT_STOCK", "message": "…", "details": [] }`

Messages are fixed per code, in English, and never echo request values. The web app translates by `code`.

| code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Invalid body, header or unknown property. `details` lists `field: rule` per failure. |
| `MISSING_IDEMPOTENCY_KEY` | 400 | `POST /transactions` without `Idempotency-Key`. |
| `INVALID_SIGNATURE` | 401 | Webhook checksum mismatch. |
| `FORBIDDEN_ORIGIN` | 403 | Missing or invalid `X-Origin-Verify`. |
| `PRODUCT_NOT_FOUND` | 404 | Unknown product id. |
| `CUSTOMER_NOT_FOUND` | 404 | Unknown customer id. |
| `TRANSACTION_NOT_FOUND` | 404 | Unknown transaction id, including a malformed id. |
| `DELIVERY_NOT_FOUND` | 404 | Unknown delivery id. |
| `ROUTE_NOT_FOUND` | 404 | No route matches. |
| `INSUFFICIENT_STOCK` | 409 | Requested quantity above stock. `details` carries `quantity: available=<n>`. |
| `IDEMPOTENCY_KEY_IN_PROGRESS` | 409 | Same key still being processed. |
| `PAYLOAD_TOO_LARGE` | 413 | Body above the size limit. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `POST` body with a media type other than `application/json`, or a charset other than `utf-8`. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different body. |
| `TOO_MANY_REQUESTS` | 429 | Rate limit exceeded. |
| `INTERNAL_ERROR` | 500 | Unexpected failure. No stack trace in the body. |
| `PAYMENT_PROVIDER_ERROR` | 502 | Provider 4xx on the first creation attempt, or provider unreachable on `GET /acceptance-tokens`. |

## Rate limit
- 60 requests per 60 s per Client_IP across all routes under `/api/v1`, except `GET /api/v1/health`, which is never counted and never answered 429. The 61st request in a window answers 429 `TOO_MANY_REQUESTS`.
- The key is the `CloudFront-Viewer-Address` header with the port removed (split at the last `:`, so IPv6 works). If the header is missing or has no `:`, the remote socket address (the CloudFront edge) is used instead. `X-Forwarded-For` is never read.
- Sliding window: each counted request expires 60 s after it arrived. A rejected request does not extend the block.
- Counters live in the memory of each Lambda execution environment, so they reset on a cold start and are not shared between concurrent containers.
- Clients behind the same NAT share one quota.
- A checkout that polls `GET /transactions/:id` every 2 s for 60 s uses about 35-45 requests per minute, below the limit.

## Cross-cutting
- Controllers only validate DTOs (`whitelist` + `forbidNonWhitelisted`) and map `Result` → HTTP. No business logic.
- Every response has `X-Request-Id`. Never return card tokens. Never expose stack traces.
- Requests without a valid `X-Origin-Verify` header → 403 `FORBIDDEN_ORIGIN`.
- OpenAPI from `@nestjs/swagger` decorators, generated at build time into `docs/openapi.json` (no Swagger UI served by the Lambda, because the esbuild bundle cannot resolve `swagger-ui-dist` assets). The Docs_Site is published as static files under `/docs/` from S3 (Swagger UI at `/docs/`, document at `/docs/openapi.json`), and a Postman collection lives in `docs/postman/`.
