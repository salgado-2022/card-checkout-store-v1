---
inclusion: fileMatch
fileMatchPattern: ["api/src/infrastructure/http/**", "web/src/shared/api/**", "docs/**postman**"]
---
# API contract (`/api/v1`, JSON, camelCase, integer cents, ULID ids)

| Method | Path | Responses |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/products` | 200 |
| GET | `/products/:id` | 200, 404 |
| GET | `/fees` | 200 |
| GET | `/acceptance-tokens` | 200, 502 |
| POST | `/customers` (upsert by email) | 201, 200, 400 |
| GET | `/customers/:id` | 200, 404 |
| POST | `/transactions` (requires `Idempotency-Key`) | 201, 200 (idempotent replay), 400, 404, 409, 422, 502 |
| GET | `/transactions/:id` (syncs with provider if PENDING) | 200, 404 |
| GET | `/deliveries/:id` | 200, 404 |
| POST | `/webhooks/payments` | 200, 401 |

`POST /transactions` body: `productId`, `quantity` (1..5), `customerId`, `delivery { recipientName, phone, addressLine1, addressLine2?, city, department, postalCode? }`, `payment { cardToken, installments, brand, lastFour }`, `acceptanceToken`, `acceptPersonalAuth`. Response 201: `id`, `reference` (`ORD-<ULID>`), `status`, `amounts { currency, subtotalInCents, baseFeeInCents, deliveryFeeInCents, totalInCents }`, `deliveryId`, `card { brand, lastFour }`, `createdAt`. Client-sent amounts are ignored.

## Error format (all 4xx/5xx)
`{ "statusCode": 409, "code": "INSUFFICIENT_STOCK", "message": "…", "details": [] }`

| code | HTTP |
|---|---|
| VALIDATION_ERROR (details: field + rule) | 400 |
| MISSING_IDEMPOTENCY_KEY | 400 |
| INVALID_SIGNATURE | 401 |
| PRODUCT_NOT_FOUND, CUSTOMER_NOT_FOUND, TRANSACTION_NOT_FOUND, DELIVERY_NOT_FOUND | 404 |
| INSUFFICIENT_STOCK | 409 |
| IDEMPOTENCY_KEY_REUSED | 422 |
| TOO_MANY_REQUESTS | 429 |
| PAYMENT_PROVIDER_ERROR | 502 |

## Cross-cutting
- Controllers only validate DTOs (`whitelist` + `forbidNonWhitelisted`) and map `Result` → HTTP. No business logic.
- Every response has `X-Request-Id`. Never return card tokens. Never expose stack traces.
- Requests without a valid `X-Origin-Verify` header → 403. Rate limit 60 req/min per IP.
- OpenAPI from `@nestjs/swagger` decorators, generated at build time into `docs/openapi.json` (no Swagger UI served by the Lambda, because the esbuild bundle cannot resolve `swagger-ui-dist` assets). Swagger UI is published as static files under `/docs/` from S3, and a Postman collection lives in `docs/postman/`.
