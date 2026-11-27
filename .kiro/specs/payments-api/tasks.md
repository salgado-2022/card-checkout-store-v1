# Implementation Plan: Payments API

## Overview

The work is split into seven branches, one pull request each, in dependency order. Every top-level task is one branch and ends with a checkpoint sub-task followed by a **[MANUAL — developer only]** sub-task (push, PR, green CI, merge, approve the deploy, smoke check on the CloudFront URL).

| # | Branch | Scope |
|---|---|---|
| 1 | `feat/HU-01-catalog-foundation` | Dependencies, domain layer, ports, in-memory fakes, application-layer dependency rule, error catalog and mapper, content-type guard, products and fees endpoints, Terraform-seeded catalog, `dynamodb:Scan` and seed-item grants in `infra/bootstrap` |
| 2 | `feat/HU-09-customers-acceptance` | Log masking, customers upsert and lookup, provider call policy (Standard and Single_Attempt profiles), payment gateway adapter base, acceptance tokens, reference-lookup Sandbox check |
| 3 | `feat/HU-09-transactions` | Create transaction (HU-09), charge the provider (HU-10), idempotency, Amount_Check, finalization core, Lambda timeout |
| 4 | `feat/HU-11-sync-deliveries` | Provider status and reference lookup, status sync, reconciliation, `GET /transactions/:id`, `GET /deliveries/:id`, finalization and Amount_Check properties, cross-resource properties |
| 5 | `feat/HU-19-docs-rate-limit` | OpenAPI generation, docs site, `/docs/*` CloudFront behaviors, deploy and CI changes, Postman, steering docs, rate limit by client IP (health excluded), custom `/api/*` origin request policy |
| 6 | `feat/HU-13-payment-webhook` | Optional, cut first if late. Event checksum and webhook. Comes after docs and rate limit, before the evidence branch |
| 7 | `docs/payments-api-evidence` | Deployed end-to-end evidence script and `docs/evidence/payments-api.md` |

Conventions for every task:

- Language is TypeScript (`strict: true`), Node.js 22, tests with Jest only (`ts-jest`). Never Vitest or Mocha.
- Each sub-task is sized for about 1 hour or less and includes its own Jest tests in the same sub-task.
- Property-based tests use `fast-check`, tagged `Feature: payments-api, Property N: <text>`. Each property is its own sub-task and states its run count: **`numRuns: 25`** for a property that sends requests through HTTP with `supertest` (a real Nest `INestApplication`, even with faked ports underneath), **`numRuns: 100`** for a property of a pure function and for a property exercised directly against use cases or adapters with fakes or mocks, without the Nest HTTP pipeline. The value travels with the `fast-check` call of the test.
- Test sub-tasks are not optional (no `*` marker) in branches 1 to 5 and 7: the 80% coverage gate on `api/` is a never-cut item. The only optional sub-tasks are the webhook property tests of branch 6, marked `*`. Every webhook implementation sub-task carries its own example tests, so coverage stays at or above 90% with or without the optional property tests, and the code of the whole branch can be left out without touching the coverage of the other branches.
- Use the generic word `payment` for the provider. No provider company name or documentation link anywhere (code, tests, fixtures, comments, docs, commit text). Run `bash scripts/check-forbidden-words.sh` before handing work back.
- Fixtures use fake values such as `pub_test_fake`. Tests use `aws-sdk-client-mock` for DynamoDB and `nock` for the provider HTTP calls. No real network, AWS call or key in any test.
- Use cases and adapters return neverthrow `Result`/`ResultAsync`. They never throw for business errors.
- Provider call profiles: `create` and `getAcceptanceTokens` use the Standard_Profile (10 s per attempt, one retry after 500 ms on timeout or 5xx, never on 4xx). `getStatus` and `findByReference` use the Single_Attempt_Profile (one attempt, 3 s, no retry). A creation request is never sent from `GET /transactions/:id` or from the webhook.
- Every controller sub-task adds the `@nestjs/swagger` decorators of its endpoints (request DTOs, response schemas, every documented status code) so branch 5 can generate the document.
- Agents never run `git commit`, `git push`, `terraform plan`, `terraform apply`, `terraform destroy`, never use AWS credentials and never call the payment provider with real keys. Agents may run only `terraform fmt`, `terraform init -backend=false` and `terraform validate`.
- Tasks marked **[MANUAL — developer only]** are for the Developer. Agents skip them and report readiness.
- Tasks marked "Suggested executor: senior" are critical paths (signature, idempotency, atomic finalization, reconciliation, webhook).
- Commands run inside `api/` unless a task says otherwise.

## Tasks

### Branch `feat/HU-01-catalog-foundation`

- [ ] 1. Catalog foundation: domain, ports, error pipeline, products and fees, Terraform seed and bootstrap grants
  - [x] 1.1 Declare the missing dependencies
    - In `api/package.json` add under `dependencies`: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@nestjs/throttler`, `@nestjs/swagger`, `class-validator`, `class-transformer`, `ulid`. Add under `devDependencies`: `swagger-ui-dist`, `nock`. Keep existing entries. Use versions compatible with NestJS 11 and Node 22, then refresh `api/package-lock.json` with `npm install`.
    - Confirm `npm ci` exits 0, then confirm `npm run build` still exits 0 and the Lambda bundle keeps Nest DI working (extend the `external` list in `api/scripts/build-lambda.ts` only for optional Nest packages that fail to resolve, such as `@nestjs/swagger` peers).
    - Jest test `api/test/tooling/dependencies.spec.ts`: reads `package.json` and asserts each package above is in the right section, `nock` or `msw` is present, and neither `vitest` nor `mocha` appears.
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5_
  - [x] 1.2 Implement the domain layer
    - Files in `api/src/domain/`: `money.ts` (integer cents + `Currency` "COP", `add`, `multiply`, equality), `card-brand.ts` (`CardBrand` + type guard), `transaction-status.ts` (`TransactionStatus`, `FinalStatus`, `canTransitionTransaction`), `delivery-status.ts` (`DeliveryStatus`, `canTransitionDelivery`), `amounts.ts` (`computeAmounts(unitPriceInCents, quantity, baseFeeInCents, deliveryFeeInCents)` returning integer `subtotalInCents` and `totalInCents`), `reference.ts` (`ORD-<ULID>` value object and `isValidReference`), `errors.ts` (domain error union `INSUFFICIENT_STOCK`, `INVALID_TRANSITION`, `INVALID_AMOUNTS`), `entities.ts` (`Product`, `Customer`, `Transaction`, `Delivery` as plain interfaces with the fields of the Glossary and the data model). `amount-check.ts` is added in branch 3, next to the finalization core that uses it. Remove the `.gitkeep` of the folder.
    - No import from NestJS, the AWS SDK or an HTTP library. No `any` (the `no-explicit-any` domain lint rule applies).
    - Plain Jest tests, no mocks, 100% coverage of the domain: the vector price 12000000, quantity 2, base fee 300000, delivery fee 800000 gives `totalInCents` 25100000; every transition pair; reference format and rejection of malformed values; `Money` arithmetic and non-integer rejection.
    - _Requirements: 5.9, 5.10, 10.7, 17.1, 21.2_
  - [x] 1.3 Property test for the amounts invariant
    - **Property 12: Amounts invariant**
    - **Validates: Requirements 5.9, 5.10, 21.2**
    - `fast-check` with `numRuns: 100` (pure function) over integer unit prices, quantity 1..5 and non-negative integer fees: `subtotalInCents = unitPrice × quantity`, `totalInCents` equals the sum of subtotal and both fees, and every field is an integer. Keep the known vector as a fixed example in the same file `api/src/domain/amounts.property.spec.ts`.
    - _Requirements: 5.9, 5.10, 21.2, 21.11, 21.17_
  - [x] 1.4 Property test for status transitions
    - **Property 32: The transition functions only allow the documented moves**
    - **Validates: Requirements 10.7**
    - `fast-check` with `numRuns: 100` (pure function) over all `(from, to)` pairs of the status unions: `canTransitionTransaction` is true only for PENDING → a final status, `canTransitionDelivery` is true only for PENDING → ASSIGNED, BACKORDER or CANCELLED. File `api/src/domain/transitions.property.spec.ts`.
    - _Requirements: 10.7, 21.17_
  - [x] 1.5 Define the ports and the shared application types
    - Files in `api/src/application/ports/`: `product-repository.ts`, `customer-repository.ts`, `transaction-repository.ts` (with `finalize(input): ResultAsync<FinalizeOutcome, RepositoryError>`), `delivery-repository.ts`, `idempotency-repository.ts` (with `BeginOutcome` as the discriminated union of the design), `payment-gateway.ts` (`getAcceptanceTokens`, `create`, `getStatus`, `findByReference` with `ReconciliationOutcome`), `clock.ts`, `id-generator.ts`. Add one small port the design needs for the "warning log" and "alert log" behaviors without breaking the layering: `application-logger.ts` (`info`, `warn`, `alert` with a plain fields object). The `EventChecksumVerifier` port is not created here: task 6.2 creates it with its adapter, so cutting branch 6 leaves no unused port.
    - Document in comments which profile each `PaymentGateway` method runs under: `getAcceptanceTokens` and `create` under the Standard_Profile, `getStatus` and `findByReference` under the Single_Attempt_Profile. The provider status types (`ProviderStatus`, the create response and the `found` outcome of `ReconciliationOutcome`) carry `status`, `message`, `amountInCents`, `currency` and `reference`, the three fields the Amount_Check compares.
    - `ProductRepository` exposes `findAll` and `findById` only: the stock decrement exists only inside `TransactionRepository.finalize`, so no unused port method is left behind.
    - `PaymentGatewayError` distinguishes `REJECTED` (HTTP 4xx, with the provider message and a flag `afterTransientFailure` for a 4xx that follows a timeout or 5xx), `UNAVAILABLE` (timeout or 5xx after the retry) and `INVALID_RESPONSE`.
    - Add `api/src/application/errors.ts`: `RepositoryError`, `PaymentGatewayError` and the `ApplicationError` union, each variant carrying only a `kind` and non-sensitive fields. Remove the `.gitkeep` files of `ports/` and `use-cases/` once real files exist.
    - Type-only files: no runtime code, no test needed beyond `npx tsc --noEmit`.
    - _Requirements: 17.2, 17.4, 17.9_
  - [x] 1.6 Create the in-memory fake ports for tests
    - In `api/test/support/`: `fake-clock.ts` (settable and advanceable), `fake-id-generator.ts` (deterministic ULID-shaped ids), `in-memory-product-repository.ts`, `in-memory-customer-repository.ts`, `in-memory-transaction-repository.ts` (including an in-memory `finalize` that honors the `status = PENDING` and `stock >= quantity` conditions), `in-memory-delivery-repository.ts`, `in-memory-idempotency-repository.ts` (implements every `BeginOutcome` branch, fresh versus stale decided with the fake clock and a 25 s window), `fake-payment-gateway.ts` (scriptable responses per call, records every call by method name so tests can assert `findByReference` or `create` were never called), `fake-application-logger.ts`.
    - Jest test `api/test/support/fakes.spec.ts` for the behaviors the later use-case tests rely on: conditional finalize, idempotency begin outcomes, scripted gateway call log.
    - _Requirements: 21.12_
  - [x] 1.7 Add the application-layer rule to dependency-cruiser
    - In `api/.dependency-cruiser.cjs` add `application-layer-allowed-imports`: files under `^src/application` may import only `^src/domain`, `^src/application`, `neverthrow` or a Node.js built-in (`node:` prefix or core module), and never `^src/infrastructure`, `@nestjs/`, `@aws-sdk/` or HTTP libraries. Keep the existing domain rules.
    - Extend `api/test/tooling/dependency-rule.spec.ts` with temp fixtures under a `src/application` tree via `it.each`: forbidden imports exit non-zero (`@nestjs/common`, `@aws-sdk/client-dynamodb`, `express`, `../infrastructure/x`); allowed imports exit zero (`neverthrow`, `node:crypto`, `crypto`, a relative domain import, a sibling application import). Also run `npm run depcruise` on the real tree and expect exit 0.
    - _Requirements: 17.5, 17.6_
  - [x] 1.8 Error catalog and Result-to-HTTP mapper
    - Create `api/src/infrastructure/http/error-catalog.ts`: `ERROR_CATALOG` with the 17 codes and statuses of the design, a fixed English message per code (a literal, never built from request data), and `toHttpException(err: ApplicationError | DomainError): HttpException` as a pure function with one `switch` arm per `err.kind` (`REPOSITORY_ERROR` and unknown kinds map to 500 `INTERNAL_ERROR`, `PAYMENT_PROVIDER_ERROR` to 502). The catalog is the single enumeration used by the mapper, the exception filter and, later, the OpenAPI script.
    - Extend the existing `result-exception.filter.ts` and the origin guard so every 4xx/5xx body is `{ statusCode, code, message, details }` using the single catalog: align the existing generic codes (`NOT_FOUND`, `CONFLICT`, ...) to `ROUTE_NOT_FOUND` with the fixed message "Route not found." and no request path, keep `FORBIDDEN_ORIGIN`, `PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR` (fixed message, no stack trace, error written to the log). Update the existing filter and origin-guard specs that assert the old codes.
    - Tests: every catalog entry maps to its status; every `err.kind` has an arm; `ROUTE_NOT_FOUND` for an unknown route (supertest, no path echoed).
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.6, 13.8, 13.9, 17.9_
  - [x] 1.9 Content-type guard and validation pipeline
    - Create `api/src/infrastructure/http/middleware/content-type-guard.middleware.ts` (next to `body-parser-error.middleware.ts`) and register it in `create-app.ts` before the body parser and before routing. On a POST that carries a body, it parses the `Content-Type` header into a media type and its parameters (split at `;`, trim, lower-case the media type and the parameter names, accept quoted parameter values) and never compares the raw header string. It lets the request continue only when the media type equals `application/json` and the `charset` parameter is either absent or equals `utf-8`, both compared case-insensitively. A missing header, any other media type (including `application/jsonx`) or any other `charset` answers 415 `UNSUPPORTED_MEDIA_TYPE` with the standard envelope, before the body is parsed. A POST with no body is not blocked by this guard.
    - Verify in `create-app.ts` that the global `ValidationPipe` has `whitelist`, `forbidNonWhitelisted` and `transform` enabled and that its `exceptionFactory` produces a 400 `VALIDATION_ERROR` with one `details` entry per failure holding the field name and the violated rule. Verify `X-Request-Id` is returned on 4xx and 5xx.
    - Tests with supertest on a minimal module, as a table with `it.each`. Accepted: `application/json`, `application/json; charset=utf-8`, `Application/JSON; Charset=UTF-8`. Rejected with 415: `text/plain`, `application/jsonx`, `application/json; charset=latin1`, `multipart/form-data`, and a missing `Content-Type` on a POST with a body. Also: a POST with no body is not answered 415 by the guard, 400 `details` shape, unknown property rejected, `X-Request-Id` present on every error.
    - _Requirements: 13.5, 13.7, 13.10, 13.11, 14.1, 14.6, 21.9, 21.16_
  - [x] 1.10 Shared infrastructure adapters and wiring
    - Create `api/src/infrastructure/persistence/dynamodb-client.ts` (document client factory, region from the Lambda environment, `removeUndefinedValues: true`), `api/src/infrastructure/system/system-clock.ts` and `ulid-id-generator.ts` (implement `Clock` and `IdGenerator` with the `ulid` package), `api/src/infrastructure/http/logging/application-logger.adapter.ts` (implements `ApplicationLogger` on top of the existing JSON logger, carries `requestId` and the Reference when given). Add the Nest providers and injection tokens in `app.module.ts` (wiring only: no logic) and expose the validated `AppConfig` (table names and fees) as an injectable.
    - Tests: clock returns a `Date`; id generator returns a valid ULID and ids are unique and sortable; logger adapter writes one JSON line per call with the fields and without any key named like a secret.
    - _Requirements: 14.3, 17.7, 17.8_
  - [x] 1.11 DynamoDB product repository adapter
    - Create `api/src/infrastructure/persistence/product.repository.dynamodb.ts`: `findAll` uses `ScanCommand` with `ConsistentRead: true`, `findById` uses `GetCommand` with `ConsistentRead: true`; both return `Ok(null)` for a missing item and map any SDK exception to `Err({ kind: 'REPOSITORY_ERROR' })` without rethrowing and without the SDK message.
    - Tests with `aws-sdk-client-mock`: pagination of the scan through `LastEvaluatedKey`, field mapping, not found, SDK failure.
    - _Requirements: 1.1, 1.5, 1.7, 17.8, 17.9_
  - [x] 1.12 Use cases GetProducts, GetProduct and GetFees
    - Create `api/src/application/use-cases/get-products.ts` (sorted by `name` ascending, maps to the exact field set), `get-product.ts` (`null` gives `PRODUCT_NOT_FOUND`, also for an id of any format), `get-fees.ts` (pure function of the configured fees, always `Ok`, `currency` "COP"). Constructor injection of ports, no framework imports.
    - Tests with the in-memory fakes: ordering, stock 0 included, not found, repository error propagation, fee echo.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 17.3, 17.4_
  - [x] 1.13 Products and fees controllers
    - Create `ProductsController` (`GET /products`, `GET /products/:id`) and `FeesController` (`GET /fees`) in `api/src/infrastructure/http/controllers/`, with response DTO classes carrying `@ApiProperty`/`@ApiResponse` decorators including the error envelope for 404. Controllers only call the use case and map the `Result` through `toHttpException`. Register the controllers and the use-case providers in `app.module.ts`. Read `BASE_FEE_IN_CENTS` and `DELIVERY_FEE_IN_CENTS` through the validated config (defaults 300000 and 800000 already enforced by the schema; add a test if missing).
    - supertest tests with the fake application layer: 200 shapes, 404 `PRODUCT_NOT_FOUND` for a missing id and for a malformed id, 200 fees.
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 2.1, 2.2, 13.9, 17.7, 18.1_
  - [x] 1.14 Bootstrap and Lambda grants: `dynamodb:Scan`, seed-item actions and the re-apply note
    - In one change: `infra/lambda.tf` adds the statement `ProductsTableScan` (action `dynamodb:Scan`, resource `aws_dynamodb_table.products.arn` only). `infra/bootstrap/main.tf` adds the statement `ProductsTableScan` to `aws_iam_policy.lambda_boundary` and the statement `ProductsTableSeedItems` (`dynamodb:PutItem`, `dynamodb:GetItem`, `dynamodb:DeleteItem`) to `aws_iam_role_policy.deploy`, both with the literal resource `arn:aws:dynamodb:<region>:<account>:table/${var.project_name}-products` (no wildcard, no index, no other table). Keep the existing table-level `DynamoDb` statement untouched. Run `terraform fmt` on the edited files.
    - `docs/deployment.md`: amend section 2 to say bootstrap is the only recurring manual infrastructure step and add the prominent note of the design (Open Point C) telling the Developer to re-apply `infra/bootstrap` once, with the `terraform apply -var ...` command, before deploying this branch. The note explains that the re-apply adds `dynamodb:Scan` to the permissions boundary and the three item actions to the Deploy_Role, and that skipping it makes `terraform apply` fail with access denied on the seed items.
    - Static Jest tests in `api/test/infra/` (read the files as text, never apply): `dynamodb:Scan` appears in `lambda.tf` and `bootstrap/main.tf` only on the products table ARN, never with `index/`, never with `*`; in `bootstrap/main.tf` the `ProductsTableSeedItems` statement lists exactly `PutItem`, `GetItem` and `DeleteItem` on the products table ARN only, with no index and no wildcard; the bootstrap has no other new action; `docs/deployment.md` mentions `dynamodb:Scan`, `PutItem` and `infra/bootstrap`. Update `bootstrap-policy.spec.ts` if it asserts the exact action list.
    - _Requirements: 16.6, 16.7, 16.10, 19.3, 19.4, 19.5, 19.6, 21.14_
  - [x] 1.15 Terraform-seeded catalog and removal of the seed script
    - `infra/dynamodb.tf`: add 4 `aws_dynamodb_table_item` resources (`product_1` to `product_4`) on `aws_dynamodb_table.products`, as in Open Point C. Each has a fixed ULID `id` (26 characters, Crockford alphabet), `sku`, `name`, `description` (plain text, no provider name), `imageUrl` of the form `/images/<slug>.webp`, `priceInCents` as an integer, `currency` "COP" and `stock`. Stock rule: one product with 0, one with 1, the other two with 5 and 10 (inside 2 to 20, so the evidence script finds a product with stock of at least 3). Every item declares `lifecycle { ignore_changes = [item] }`. Run `terraform fmt`.
    - Remove the placeholder `api/scripts/seed.ts`, remove `'/scripts/seed\\.ts$'` from `coveragePathIgnorePatterns` in `api/jest.config.ts` and from the expected list in `api/test/tooling/jest-config.spec.ts`. Confirm `api/package.json` has no `seed` script and `docs/deployment.md` and `README.md` have no manual seed step. Steering edits, limited to these two deletions and nothing else: remove the single line `scripts/seed.ts` from the tree in `.kiro/steering/structure.md`, and remove only the words ", seed script" from the "Allowed exclusions only" sentence of `.kiro/steering/tech.md`. Show the Developer the two-line diff of these project-rule files before the checkpoint, because the steering files are shared project rules.
    - Static Jest test `api/test/infra/seed-items.spec.ts` (reads `infra/*.tf` as text): exactly 4 `aws_dynamodb_table_item` resources and all on the products table; unique ids in ULID format; stock distribution (one 0, one 1, two in 2..20); `imageUrl` starts with `/images/` and ends with `.webp`; `currency` "COP"; `priceInCents` integer; `ignore_changes = [item]` on every item; `api/scripts/seed.ts` does not exist; `api/package.json` has no `seed` script; `docs/deployment.md` and `README.md` contain no seed step.
    - The `imageUrl` values must match the files the `checkout-web` spec adds under `web/public/images/`. Until then the deployed catalog shows broken images, which does not affect the API checks.
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.8, 16.9, 21.13, 21.14_
  - [x] 1.16 Property test for the product list
    - **Property 1: Products are listed completely, sorted, with the exact field set**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over arbitrary product sets (including `stock` 0) through the HTTP layer with in-memory fakes: all products present, sorted by `name` ascending, exactly the eight fields. File `api/src/infrastructure/http/controllers/products.property.spec.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 21.17_
  - [x] 1.17 Property test for strongly consistent reads
    - **Property 4: Strongly consistent product reads**
    - **Validates: Requirements 1.7**
    - `fast-check` with `numRuns: 100` (adapter level, no HTTP). With `aws-sdk-client-mock`, for any list or detail call through the real adapter, the recorded DynamoDB command input has `ConsistentRead: true`.
    - _Requirements: 1.7, 21.17_
  - [x] 1.18 Property test for the fees endpoint
    - **Property 5: Fees echo the configured values**
    - **Validates: Requirements 2.1, 2.2**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over non-negative integer fee pairs (and the defaults): `GET /fees` returns 200, `currency` "COP" and exactly those two values.
    - _Requirements: 2.1, 2.2, 21.17_
  - [x] 1.19 Property test for the error envelope
    - **Property 36: Every error response uses the fixed envelope and the documented status**
    - **Validates: Requirements 13.1, 13.3, 13.4, 13.6, 13.8**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). Iterate `ERROR_CATALOG` so later codes are covered automatically: for each code, trigger or simulate it (a code whose route is not delivered, such as `INVALID_SIGNATURE` while branch 6 is not merged, is simulated through a throwing test-only controller), assert the body is exactly `{ statusCode, code, message, details }`, the status matches the catalog, and adversarial request values (path, header values, body fields from `fast-check` strings) never appear in `message`.
    - _Requirements: 13.1, 13.3, 13.4, 13.6, 13.8, 21.17_
  - [x] 1.20 Property test for the media-type guard
    - **Property 37: The media-type guard accepts exactly `application/json` with an absent or `utf-8` charset, case-insensitively, and rejects everything else before any body parsing**
    - **Validates: Requirements 13.5, 13.10, 13.11**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). Generate accepted values by random casing of `application/json` with optional spaces around `;` and an optional `charset=utf-8` in any casing: every one continues the request. Generate rejected values from other media types, near misses such as `application/jsonx`, other charsets (`latin1`, `utf-16`, empty) and a missing header: every one answers 415 `UNSUPPORTED_MEDIA_TYPE` and the JSON parser never runs (assert with a spy on the body parser or a body that would fail parsing).
    - _Requirements: 13.5, 13.10, 13.11, 21.16, 21.17_
  - [x] 1.21 Property test for request id and origin guard
    - **Property 38: Every response carries a request id, and the origin guard is absolute**
    - **Validates: Requirements 14.1, 14.2**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over methods, paths and headers: every response has `X-Request-Id`; any business route without a valid `X-Origin-Verify` answers 403 `FORBIDDEN_ORIGIN`.
    - _Requirements: 14.1, 14.2, 21.17_
  - [x] 1.22 Property test for unexpected adapter failures
    - **Property 43: Unexpected adapter failures are translated, never leaked**
    - **Validates: Requirements 17.9**
    - `fast-check` with `numRuns: 100` (adapter and use-case level with `aws-sdk-client-mock`, no HTTP). A mocked SDK that rejects with arbitrary errors (messages carrying `fast-check` strings) behind the product repository and the use cases: the adapter returns an `Err` `REPOSITORY_ERROR` that holds no trace of the original message or stack. One example test through supertest asserts the HTTP translation: 500 `INTERNAL_ERROR` with the fixed message, no stack and no original message in the body or the log output of the response.
    - _Requirements: 17.9, 21.17_
  - [x] 1.23 Checkpoint, `feat/HU-01-catalog-foundation`
    - Run `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (all four metrics at least 80), `npm run build`, `npm run depcruise`, `bash scripts/check-forbidden-words.sh` from the repo root (no findings). Run `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` in `infra/` and in `infra/bootstrap/`. Do not run `terraform plan` or `terraform apply`.
    - Confirm `api/jest.config.ts` excludes from coverage only `main.ts`, `lambda.ts`, wiring-only `*.module.ts` and `.d.ts`, and keeps the global threshold at 80 for the four metrics. Do not widen the exclusions in any later branch.
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 17.6, 19.6, 20.5, 21.1, 21.13_
  - [ ] 1.24 **[MANUAL — developer only]** Bootstrap re-apply, push, PR, merge, deploy and smoke check
    - Run `git config core.hooksPath .githooks` once so the `pre-commit` and `commit-msg` hooks run locally.
    - **One-time bootstrap re-apply, before merging** (the merge starts the deploy, and that deploy creates the seed items): with your own AWS credentials run in `infra/bootstrap/`: `terraform init`, `terraform plan -var github_owner=<owner> -var github_owner_id=<id> -var github_repo=<repo> -var github_repo_id=<id> -var state_bucket_name=<bucket> -var project_name=card-checkout-store`, review that only the `lambda_boundary` policy version and the deploy role policy change (the two new statements), then `terraform apply` with the same variables. The Lambda role references the boundary by ARN, so it is covered as soon as the apply ends. Without this step the deploy fails with access denied on the seed items, and `GET /api/v1/products` fails at runtime with an access-denied error.
    - Create `feat/HU-01-catalog-foundation`, review the diff, commit in small Conventional Commits (`chore(api): add runtime dependencies`, `feat(api): add domain layer`, `feat(api): add application ports`, `test(api): add in-memory fake ports`, `chore(api): add application dependency rule`, `feat(api): add error catalog and mapper`, `feat(api): add content type guard`, `feat(api): add dynamodb product repository`, `feat(api): add products and fees endpoints`, `feat(infra): grant scan and seed item actions`, `feat(infra): seed catalog with terraform`, `docs: add bootstrap re-apply note`), push, open the PR with the template and wait for green CI (gitleaks and forbidden words included).
    - Squash merge to `master`. `deploy.yml` starts after `ci.yml` finishes green: read the plan summary (4 new `aws_dynamodb_table_item`), approve the `production` gate and wait for `apply`, `deploy-api`, `deploy-web` and `smoke-test`.
    - Smoke check: `bash scripts/smoke-test.sh https://<distribution-domain>`; `curl -s https://<distribution-domain>/api/v1/products` returns 200 and the 4 seeded products with no other step (one with `stock` 0, one with `stock` 1); `curl -s https://<distribution-domain>/api/v1/fees` returns `{"currency":"COP","baseFeeInCents":300000,"deliveryFeeInCents":800000}`; `curl -s https://<distribution-domain>/api/v1/products/unknown` returns 404 `PRODUCT_NOT_FOUND`; `curl -s -X POST https://<distribution-domain>/api/v1/customers -H 'Content-Type: text/plain' -d 'x'` returns 415 `UNSUPPORTED_MEDIA_TYPE`. A 500 on products means the bootstrap re-apply is missing.
    - Agents must not run `git commit`, `git push` or `terraform apply`.
    - _Requirements: 16.5, 19.5_


### Branch `feat/HU-09-customers-acceptance`

- [ ] 2. Customers, provider call policy and acceptance tokens
  - [x] 2.1 Log masking in the application logger
    - Create `api/src/infrastructure/http/logging/mask.ts`: `maskEmail` keeps the first character of the local part, then `***`, then the unchanged domain; `maskDocumentNumber` replaces every character except the last 3 with `*` and keeps the length. Apply both automatically to the fields named `email`, `customerEmail`, `documentNumber` in the `ApplicationLogger` adapter and the JSON logger, so no use case has to remember to mask.
    - Tests: examples (`john.doe@example.com` → `j***@example.com`, `1234567890` → `*******890`), short values, and the adapter output never contains the raw value.
    - _Requirements: 14.3, 14.4, 14.5_
  - [x] 2.2 DynamoDB customer repository adapter
    - Create `api/src/infrastructure/persistence/customer.repository.dynamodb.ts`: `findByEmail` queries the GSI `email`, `findById` uses `GetCommand`, `upsert` creates a new item with `id` from `IdGenerator`, `createdAt` and `updatedAt` (conditional put on `attribute_not_exists(id)`) or updates `fullName`, `phone`, `documentType`, `documentNumber` and `updatedAt` while keeping `id` and `createdAt`; it returns whether the record was created. Any SDK exception becomes `Err({ kind: 'REPOSITORY_ERROR' })`.
    - Tests with `aws-sdk-client-mock`: create path, update path, GSI query shape, SDK failure.
    - _Requirements: 3.1, 3.2, 3.3, 17.8, 17.9_
  - [x] 2.3 Use cases UpsertCustomer and GetCustomer
    - Create `upsert-customer.ts` (normalize the email by trimming and lower-casing before lookup and storage, call `upsert`, return `{ customer, created }`, write an `info` log with the customer id and the email) and `get-customer.ts` (`null` gives `CUSTOMER_NOT_FOUND`).
    - Tests with fakes: new email creates, same email with different case and spaces updates the same record, not found, repository error.
    - _Requirements: 3.1, 3.2, 3.3, 3.9, 3.10, 17.3, 17.4_
  - [x] 2.4 Customers DTO, controller and wiring
    - Create `create-customer.dto.ts` with `class-validator` rules: `fullName` 3–80, `email` valid and at most 120, `phone` `^3\d{9}$`, `documentType` in CC/CE/NIT/PP, `documentNumber` conditional on the type (CC and CE 6–10 digits, NIT 9–10 digits, PP 6–12 alphanumeric), with `@ApiProperty` decorators. Create `CustomersController` (`POST /customers` answers 201 or 200, `GET /customers/:id`) returning `id`, `email`, `fullName`, `phone`, `documentType`, `documentNumber`, `createdAt`, `updatedAt`. Register in `app.module.ts`.
    - supertest tests: 201, then 200 on update, each invalid field gives 400 `VALIDATION_ERROR` with `details` naming the field and rule, unknown property rejected, 404 `CUSTOMER_NOT_FOUND`.
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 13.7, 13.9, 18.1_
  - [x] 2.5 Provider call policy with its two profiles
    - Create `api/src/infrastructure/payment/provider-call-policy.ts` with two named wrappers around one `AbortController`-based attempt primitive, both returning `ResultAsync<Response, PaymentGatewayError>`: `withStandardProfile(fn)` (timeout 10 s per attempt, exactly one retry after a 500 ms backoff, retry only on timeout or HTTP 5xx, never on 4xx, never a third attempt; used by `create` and `getAcceptanceTokens`) and `withSingleAttemptProfile(fn)` (timeout 3 s, exactly one attempt, no retry under any outcome; used by `getStatus` and `findByReference`). The error records whether a 4xx came after a transient failure (`afterTransientFailure`). Timeouts and the backoff are injectable so tests use fake timers.
    - Tests with Jest fake timers: Standard_Profile success first try, 5xx then success, timeout then success, 5xx twice gives `UNAVAILABLE`, 4xx is not retried, 5xx then 4xx gives `REJECTED` with `afterTransientFailure: true`; Single_Attempt_Profile timeout at 3 s gives `UNAVAILABLE` with no second attempt, 5xx and 4xx each make exactly one attempt.
    - _Requirements: 4.2, 4.3, 8.3, 9.3_
  - [x] 2.6 Payment gateway adapter base and acceptance tokens
    - Generalize the existing `origin-secret.provider.ts` SSM cache pattern into a reusable parameter reader (module-scope cache by parameter name, loaded once per cold start) and test it with a fake parameter name. Task 3.8 reads `PAYMENT_PRIVATE_KEY_PARAM` and `PAYMENT_INTEGRITY_SECRET_PARAM` through it, and task 6.2 reads `PAYMENT_EVENTS_SECRET_PARAM`, so no code that only the webhook needs lands before branch 6. Keep the origin secret behavior and its tests unchanged.
    - Create `api/src/infrastructure/payment/payment-gateway.adapter.ts` implementing `getAcceptanceTokens` under `withStandardProfile`: `GET {PAYMENT_API_URL}/merchants/{PAYMENT_PUBLIC_KEY}`; map `acceptance_token` and `accept_personal_auth` to `acceptanceToken { token, permalink }` and `acceptPersonalAuth { token, permalink }`; 4xx or exhausted retries give `Err`. Every error carries only a `reason` string (HTTP status or exception class name): no key, secret, token or response body is logged or returned.
    - Tests with `nock` and `aws-sdk-client-mock` (SSM): mapping, 4xx, 5xx twice, secrets never appear in error values or log output.
    - _Requirements: 4.1, 4.2, 4.3, 7.8, 7.9_
  - [x] 2.7 GetAcceptanceTokens use case, controller and wiring
    - Create `get-acceptance-tokens.ts` (calls the port, maps a gateway error to `PAYMENT_PROVIDER_ERROR`) and `AcceptanceTokensController` (`GET /acceptance-tokens`, response DTO and swagger decorators, 200 and 502). Register the controller, the adapter and the use case in `app.module.ts`.
    - Tests: use case with the fake gateway; supertest 200 shape and 502 `PAYMENT_PROVIDER_ERROR` with the fixed message.
    - _Requirements: 4.1, 4.2, 13.9, 17.3, 18.1_
  - [x] 2.8 Property test for the customer upsert round trip
    - **Property 6: Customer upsert is a normalized-email round trip**
    - **Validates: Requirements 3.1, 3.2, 3.3**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over valid customers and email variants (case, surrounding whitespace): the second upsert keeps `id` and `createdAt` and answers "updated"; a never-seen normalized email always creates.
    - _Requirements: 3.1, 3.2, 3.3, 21.17_
  - [x] 2.9 Property test for log masking
    - **Property 39: Log masking is a pure, lossy function of its input**
    - **Validates: Requirements 14.4, 14.5**
    - `fast-check` with `numRuns: 100` (pure function): email output is the first local-part character, `***`, then the unchanged domain; document output keeps length and the last three characters and replaces the rest with `*`.
    - _Requirements: 14.4, 14.5, 21.17_
  - [x] 2.10 Property test for unknown properties on customers
    - **Property 8: Unknown or malformed request bodies are rejected on customers and transactions (customers part)**
    - **Validates: Requirements 14.6**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) adds an undeclared property (including `amount`-shaped names) to valid `POST /customers` bodies: 400 `VALIDATION_ERROR` and no write. The transactions part of this property is task 3.16.
    - _Requirements: 14.6, 21.17, 21.18_
  - [x] 2.11 Property test for the provider resilience policy
    - **Property 9: Provider resilience policy is profile-specific (policy and Standard_Profile part)**
    - **Validates: Requirements 4.2, 4.3**
    - `fast-check` with `numRuns: 100` (adapter level, `nock` and fake timers, no HTTP) over sequences of simulated attempt outcomes (success, 4xx, 5xx, timeout): under `withStandardProfile` and through the real `getAcceptanceTokens`, a second attempt happens if and only if the first timed out or returned 5xx, never after a 4xx, never a third attempt; under `withSingleAttemptProfile` exactly one attempt with a 3 s timeout is made for every outcome. The adapter-level Single_Attempt part for `getStatus` and `findByReference` is task 4.15.
    - _Requirements: 4.2, 4.3, 21.17_
  - [x] 2.12 Checkpoint, `feat/HU-09-customers-acceptance`
    - Run `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (all four metrics at least 80), `npm run build`, `npm run depcruise`, `bash scripts/check-forbidden-words.sh` (no findings). No infra change in this branch.
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 17.6, 21.1_
  - [ ] 2.13 **[MANUAL — developer only]** Reference-lookup Sandbox check, push, PR, merge, deploy and smoke check
    - **Reference-lookup Sandbox check, before merging** (the Developer runs it with their own key, never in the repository or in an agent session). Source your git-ignored `.env`, then run `curl -s -H "Authorization: Bearer $PAYMENT_PRIVATE_KEY" "$PAYMENT_API_URL/transactions?reference=ORD-DOES-NOT-EXIST"` for an unknown Reference and the same call for the Reference of a transaction you created in the Sandbox beforehand. Confirm the lookup returns the Transaction for the known Reference and a no-record answer for the unknown one. Write the observed shapes (status code, body shape for found and not found, with no key and no real ids) in `.kiro/steering/payment-gateway.md` under a heading "Reference lookup (Sandbox result)", in the same PR. If the shape differs from the assumption of Open Point D, report it before branch 3 starts, so that only `PaymentGatewayAdapter.findByReference` (implemented in branch 4) is adjusted.
    - Create `feat/HU-09-customers-acceptance`, commit in small Conventional Commits (`feat(api): mask email and document in logs`, `feat(api): add dynamodb customer repository`, `feat(api): add customers endpoints`, `feat(api): add provider call policy`, `feat(api): add payment gateway adapter`, `feat(api): add acceptance tokens endpoint`, `docs: record reference lookup sandbox result`), push, open the PR, wait for green CI, squash merge to `master`, approve the `production` gate.
    - Smoke check: `bash scripts/smoke-test.sh https://<distribution-domain>`; `curl -s -X POST https://<distribution-domain>/api/v1/customers -H 'Content-Type: application/json' -d '{"email":"smoke@example.com","fullName":"Smoke Test","phone":"3001234567","documentType":"CC","documentNumber":"1234567890"}'` returns 201 with an `id`; repeating it returns 200 with the same `id`; `GET /api/v1/customers/<id>` returns 200; `GET /api/v1/customers/unknown` returns 404 `CUSTOMER_NOT_FOUND`; a body with a bad phone returns 400 `VALIDATION_ERROR`; `curl -s https://<distribution-domain>/api/v1/acceptance-tokens` returns 200 with `acceptanceToken` and `acceptPersonalAuth`, each with `token` and `permalink`. This is the first real call to the sandbox: if the response shape differs from the adapter mapping, report it so the mapping is fixed before branch 3.
    - Agents must not run `git commit` or `git push`.
    - _Requirements: 3.1, 3.2, 4.1, 4.4, 22.8_

### Branch `feat/HU-09-transactions`

- [ ] 3. Create the transaction, charge the provider, idempotency, Amount_Check and finalization core
  - [x] 3.1 Integrity signature
    - Create `api/src/infrastructure/payment/integrity-signature.ts`: `computeIntegritySignature(reference, amountInCents, currency, secret)` returns `sha256hex(reference + amountInCents + currency + secret)` with `node:crypto`.
    - Tests with a fixed known vector (fake reference, amount, currency and secret, expected hex computed independently and written as a literal), plus a changed field changes the hash.
    - _Requirements: 7.2, 21.3_
  - [x] 3.2 Canonical JSON and Request_Hash
    - Create `api/src/application/request-hash.ts` (uses only `node:crypto`): `canonicalJson(value)` sorts object keys recursively and keeps array order; `requestHash(body)` returns the SHA-256 hex of the canonical form.
    - Tests: key order independence at several depths, array order matters, different values give different hashes, known vector.
    - _Requirements: 6.3, 6.13_
  - [x] 3.3 DynamoDB idempotency repository adapter
    - Suggested executor: senior.
    - Create `api/src/infrastructure/persistence/idempotency.repository.dynamodb.ts`: `begin` does a conditional put (`attribute_not_exists(#key)`) with state IN_PROGRESS, `requestHash`, `createdAt` and `expiresAt` 24 h ahead as epoch seconds (the table TTL attribute); on `ConditionalCheckFailedException` it reads the record (strongly consistent) and returns `hash_mismatch`, `in_progress_fresh`, `in_progress_stale { transactionId | null }` (age against the 25 s Lambda timeout using the injected `Clock`) or `completed { statusCode, body }`; `attachTransactionId`, `complete` (state COMPLETED, stored status and body), `release` (delete) and `takeOver` (conditional update on the previous `createdAt`, returning `taken` or `lost_race`).
    - Tests with `aws-sdk-client-mock`: every `BeginOutcome` branch, TTL value, takeover race, SDK failure becomes `Err`.
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 6.10, 6.11, 6.12, 17.8, 17.9_
  - [x] 3.4 DynamoDB delivery repository adapter
    - Create `api/src/infrastructure/persistence/delivery.repository.dynamodb.ts`: `create` (conditional put on `attribute_not_exists(id)`, status PENDING, snapshot of the recipient fields, `transactionId` supplied by the caller from an id generated before both writes) and `findById` (`Ok(null)` when missing). SDK failures become `Err`.
    - Tests with `aws-sdk-client-mock`: create shape, optional fields omitted, find, not found, SDK failure.
    - _Requirements: 5.11, 11.1, 17.8, 17.9_
  - [x] 3.5 DynamoDB transaction repository adapter (reads and simple writes)
    - Create `api/src/infrastructure/persistence/transaction.repository.dynamodb.ts` with `create` (PENDING, snapshot of `unitPriceInCents`, amounts, `currency`, `installments`, `cardBrand`, `cardLastFour`, `productId`, `quantity`, `customerId`, `deliveryId`; never a card token, number, CVC or expiry), `findById`, `findByReference` (`QueryCommand` on the GSI `reference`), `setExternalId`, `setLastSynced`. `finalize` is added in 3.7.
    - Tests with `aws-sdk-client-mock`: stored item has no card data keys, GSI query shape, each write's expression, SDK failure.
    - _Requirements: 5.11, 5.12, 5.13, 8.3, 9.1, 17.8, 17.9_
  - [x] 3.6 Domain function `amount-check.ts`
    - Create `api/src/domain/amount-check.ts`: `checkAmount(reported: { amountInCents: number; currency: string; reference: string }, stored: { totalInCents: number; currency: string; reference: string }): AmountCheckResult` where `AmountCheckResult = { kind: 'match' } | { kind: 'mismatch'; fields: Array<'amountInCents' | 'currency' | 'reference'> }`. Pure strict equality on the three fields, no I/O, no framework import, field names listed in a fixed order.
    - Plain Jest tests, no mocks, 100% coverage of the file: all three fields equal gives `match`; each field differing alone gives a `mismatch` naming only that field; two and three fields differing give the exact list; a currency that differs only in letter case is a mismatch; an amount that differs by one cent is a mismatch.
    - _Requirements: 10.9, 10.10, 10.11, 17.1_
  - [x] 3.7 Transaction finalization adapter and FinalizeTransaction use case with Amount_Check
    - Suggested executor: senior.
    - Add `finalize` to the transaction repository: one `TransactWriteItemsCommand` that updates the Transaction (`status`, `statusReason`, `finalizedAt`, `updatedAt`) on `status = PENDING`, updates the Delivery (ASSIGNED, BACKORDER or CANCELLED) on `status = PENDING` and, for APPROVED, updates the Product `stock = stock - :quantity` on `stock >= :quantity`. Read `CancellationReasons` item by item: Transaction condition failed means already finalized (re-read and return the stored state); Product condition failed means no stock (retry once as BACKORDER, Transaction APPROVED, Delivery BACKORDER, stock untouched).
    - Create `finalize-transaction.ts` with an input of the stored Transaction and an outcome `{ status, message, report? }`, where `report` holds the provider-reported `amountInCents`, `currency` and `reference`. Steps: if the transaction is not PENDING return `Ok(stored)` with no write and no Amount_Check; when `report` is present run `checkAmount` against the stored values before any write, and on a mismatch finalize as ERROR with `statusReason` `AMOUNT_MISMATCH`, Delivery CANCELLED and stock unchanged, even when the provider reported APPROVED, writing an `alert` log with the Reference and the names of the fields that differ; on a match finalize with the reported status; an internal finalization without `report` (a provider rejection, `PROVIDER_UNREACHABLE`) skips the Amount_Check. On the BACKORDER outcome write an `alert` log with the Reference and the product id. Use `canTransitionTransaction` and `canTransitionDelivery` before writing. All three callers (create, sync, webhook) use this one use case, so none can finalize a reported status without the check.
    - Tests: adapter with `aws-sdk-client-mock` (APPROVED, declined family, stock condition failed, transaction condition failed, other cancellation, SDK failure); use case with fakes (no-op on a final transaction, alert log on BACKORDER, Amount_Check match, mismatch on each field overriding APPROVED and DECLINED, alert log fields, no check when `report` is absent).
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 17.3, 17.4_
  - [x] 3.8 Payment gateway adapter: create
    - Suggested executor: senior.
    - In `payment-gateway.adapter.ts` implement `create` under `withStandardProfile`: `POST {PAYMENT_API_URL}/transactions` with the private key, body `amount_in_cents`, `currency` "COP", `customer_email`, `reference`, `acceptance_token`, `accept_personal_auth`, `payment_method { type: "CARD", token, installments }` and `signature` from 3.1; map the provider id, status, message, amount, currency and reference to `{ externalId, status, message, amountInCents, currency, reference }`; a 4xx gives `REJECTED` with the provider message and `afterTransientFailure`; timeout or 5xx after the retry gives `UNAVAILABLE`. The adapter never sends a creation request from any other method. Never log or return the private key, the integrity secret, the card token or response bodies.
    - Tests with `nock` and `aws-sdk-client-mock` (SSM): exact request body and the signature, success PENDING and final status, 4xx, 5xx then 4xx flags `afterTransientFailure`, 5xx twice, secrets absent from every error value and log line.
    - _Requirements: 7.1, 7.2, 7.3, 7.6, 7.7, 7.8, 7.9, 8.1, 8.2_
  - [x] 3.9 CreateTransaction: idempotency gate, validation and PENDING persistence
    - Suggested executor: senior.
    - Create `api/src/application/use-cases/create-transaction.ts`, steps 1–10 of the design: missing or empty key gives `MISSING_IDEMPOTENCY_KEY`, malformed key gives `VALIDATION_ERROR`; `requestHash`; `begin` and each `BeginOutcome` (`hash_mismatch` → `IDEMPOTENCY_KEY_REUSED`, `in_progress_fresh` → `IDEMPOTENCY_KEY_IN_PROGRESS`, `completed` → replay with 201 replaced by 200, `in_progress_stale` with a transaction id → load it and return 200 with its current state, without one → `takeOver` and retry `begin` once on `lost_race`); product exists, customer exists, `stock >= quantity` (`INSUFFICIENT_STOCK` states the available units); on any of these failures call `release` and return the `Err`; `computeAmounts` from the configured fees; generate the Transaction id first, create the Delivery PENDING carrying that `transactionId`, then create the Transaction PENDING with the same id, the `deliveryId` and a new `ORD-<ULID>` Reference; `attachTransactionId` before any provider call. Keep the card token only in the in-memory request object.
    - Tests with fakes and the fake clock for every branch above, including that nothing is written before a failed validation and that stock is unchanged.
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.11, 5.12, 5.13, 5.15, 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 6.9, 6.10, 6.11, 17.3, 17.4_
  - [x] 3.10 CreateTransaction: provider outcomes and response
    - Suggested executor: senior.
    - Extend `create-transaction.ts`, steps 11–14: call `PaymentGateway.create` exactly once per Reference (the adapter performs the single retry inside the Standard_Profile); on success store the External_Id; a PENDING status answers 201 PENDING; a final status runs `FinalizeTransaction` with the provider-reported amount, currency and reference (Amount_Check included) before the response and answers 201 with the resulting status, which is ERROR with reason `AMOUNT_MISMATCH` on a mismatch. `REJECTED` without a prior transient failure sets the Transaction ERROR with the provider message as `statusReason` through `FinalizeTransaction`, cancels the Delivery, leaves stock unchanged and returns `PAYMENT_PROVIDER_ERROR`. `REJECTED` with `afterTransientFailure` (a 4xx on the retry after a timeout or 5xx on the first attempt) and `UNAVAILABLE` (timeout or 5xx on both attempts) both keep the Transaction and the Delivery PENDING without External_Id, run no Reconciliation (`findByReference` is never called here), send no further provider request in the request and answer 201 PENDING. Always `complete` the idempotency record with the HTTP status and the exact response body (also for the 502 case). Build the 201 body from `id`, `reference`, `status`, `amounts`, `deliveryId`, `card { brand, lastFour }`, `createdAt` only.
    - Tests with the fake gateway: PENDING, APPROVED and DECLINED on create; an APPROVED report with a different amount, currency or reference ends ERROR `AMOUNT_MISMATCH` with the Delivery CANCELLED, stock unchanged and an alert log; first-attempt 4xx gives 502 and ERROR; 5xx then 4xx gives 201 PENDING, no External_Id, Delivery PENDING and zero `findByReference` calls; 5xx twice gives 201 PENDING; the gateway `create` is called at most once per Reference; the stored response equals the returned body.
    - _Requirements: 5.14, 6.6, 7.3, 7.4, 7.5, 7.6, 7.7, 8.1, 8.2, 10.9, 17.3, 17.4, 21.15_
  - [x] 3.11 Transactions DTOs, controller and wiring
    - Create `create-transaction.dto.ts` with nested `DeliveryDto` and `PaymentDto`: `productId`, `quantity` 1–5 integer, `customerId`, `delivery { recipientName 3–80, phone ^3\d{9}$, addressLine1 5–120, addressLine2? ≤60, city 2–60, department in the 32 departments or Bogotá D.C., postalCode? 6 digits }`, `payment { cardToken, installments 1–36, brand VISA|MASTERCARD, lastFour 4 digits }`, `acceptanceToken`, `acceptPersonalAuth`; swagger decorators including the `Idempotency-Key` header and the status codes 201, 200, 400, 404, 409, 415, 422, 429, 502. Create `TransactionsController.create` (reads the header, passes it straight to the use case, answers with the status chosen by the use case, 201 or 200). Register in `app.module.ts`.
    - supertest tests with the fake application layer: 201 body has exactly the documented fields, 200 on replay, each invalid field gives 400 `VALIDATION_ERROR` with `details`, unknown or amount property rejected, missing key 400 `MISSING_IDEMPOTENCY_KEY`, 404/409/422/502 mapping, response never contains the card token.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.14, 6.1, 6.2, 6.7, 13.9, 14.6, 18.1_
  - [x] 3.12 Terraform: Lambda timeout and origin read timeout
    - `infra/lambda.tf`: `timeout = 25` (was 15). `infra/cloudfront.tf`: set `origin_read_timeout = 30` in the Lambda origin `custom_origin_config` (keep every other field). Update the foundation tests and docs that mention the 15 s timeout (`api/test/infra/terraform-static.spec.ts`, `docs/deployment.md`, `infra/README.md`) and add static assertions that the Lambda timeout is 25 and the origin read timeout is 30, above it, and that the Lambda `environment` block keeps exactly the variable names of the tech rules with no new name.
    - Run `terraform fmt` on the edited files.
    - _Requirements: 19.1, 19.2, 19.6, 19.7_
  - [x] 3.13 Property test for the integrity signature formula
    - **Property 23: Integrity signature and event checksum match their formulas (integrity signature part)**
    - **Validates: Requirements 7.2, 21.3**
    - `fast-check` with `numRuns: 100` (pure function) over `(reference, amount, currency, secret)` tuples: `computeIntegritySignature` equals an independently written `sha256hex` of the concatenation; the fixed known vector stays as an example. The event checksum part of this property is task 6.5.
    - _Requirements: 7.2, 21.3, 21.17_
  - [x] 3.14 Property test for request-hash canonicalization
    - **Property 22: Request-hash canonicalization is key-order independent**
    - **Validates: Requirements 6.13, 21.11**
    - `fast-check` with `numRuns: 100` (pure function) over random JSON objects and random key permutations at every depth: identical hash.
    - _Requirements: 6.13, 21.11, 21.17_
  - [x] 3.15 Property test for field-level validation
    - **Property 7: Field-level validation rejects out-of-rule values and names the field**
    - **Validates: Requirements 3.4, 3.5, 3.6, 3.7, 3.8, 5.2, 5.3, 5.4, 6.2, 13.7**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) generates a valid body for `POST /customers` and `POST /transactions` and breaks exactly one field with a value outside its rule (including the Idempotency-Key charset and length): 400 `VALIDATION_ERROR` with a `details` entry naming that field and rule, and no write.
    - _Requirements: 3.4, 3.5, 3.6, 3.7, 3.8, 5.2, 5.3, 5.4, 6.2, 13.7, 21.17_
  - [x] 3.16 Property test for unknown properties on transactions
    - **Property 8: Unknown or malformed request bodies are rejected on customers and transactions (transactions part)**
    - **Validates: Requirements 5.5, 14.6**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) adds an undeclared property (including `amount`-shaped names such as `totalInCents` or `amount`) to valid `POST /transactions` bodies, at the top level and inside `delivery` and `payment`: 400 `VALIDATION_ERROR` and no write, no idempotency record kept. The customers part of this property is task 2.10.
    - _Requirements: 5.5, 14.6, 21.17, 21.18_
  - [x] 3.17 Property test for insufficient stock
    - **Property 10: Insufficient stock blocks transaction creation without side effects**
    - **Validates: Requirements 5.8**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over `stock < quantity`: 409 `INSUFFICIENT_STOCK` naming the available units, no Transaction, no Delivery, no gateway call, the idempotency record released.
    - _Requirements: 5.8, 6.11, 21.17_
  - [x] 3.18 Property test for referential validation
    - **Property 11: Referential validation gates transaction creation**
    - **Validates: Requirements 5.6, 5.7**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over unknown product ids and unknown customer ids: 404 `PRODUCT_NOT_FOUND` or `CUSTOMER_NOT_FOUND` before any amount is computed or any record written.
    - _Requirements: 5.6, 5.7, 21.17_
  - [x] 3.19 Property test for persistence order
    - **Property 13: PENDING persistence happens before any Provider call**
    - **Validates: Requirements 5.11, 6.3, 6.8**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). With the recording fakes, for any valid request the call log shows idempotency `begin`, Delivery create, Transaction create and `attachTransactionId`, all strictly before `PaymentGateway.create`, with a fresh Reference.
    - _Requirements: 5.11, 6.3, 6.8, 21.17_
  - [x] 3.20 Property test for card data and secrets
    - **Property 14: Created transactions never retain card data or secrets**
    - **Validates: Requirements 5.13, 7.9**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any valid request with generated token and secret values, serialize every stored item, every response body and every log line captured during processing and assert none contains the card token, number, CVC, expiry, private key, integrity secret or events secret.
    - _Requirements: 5.13, 7.9, 21.17_
  - [x] 3.21 Property test for stock on non-final transactions
    - **Property 15: Stock is unchanged for any non-final transaction**
    - **Validates: Requirements 5.15**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any create that ends PENDING (provider PENDING, unreachable, or a 4xx on the retry), the Product stock before and after is identical.
    - _Requirements: 5.15, 21.17_
  - [x] 3.22 Property test for the idempotency key format
    - **Property 16: Idempotency key format is enforced**
    - **Validates: Requirements 6.1**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over absent, empty and whitespace-only keys: 400 `MISSING_IDEMPOTENCY_KEY` and no write. The malformed-key case is covered by Property 7.
    - _Requirements: 6.1, 21.17_
  - [x] 3.23 Property test for idempotent replay
    - **Property 17: Idempotent replay produces exactly one transaction and one Provider call**
    - **Validates: Requirements 6.6, 6.7, 21.4**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any valid key and body, two sequential requests give one Transaction, one `PaymentGateway.create` call, and the second response equals the first with 201 replayed as 200.
    - _Requirements: 6.6, 6.7, 21.4, 21.17_
  - [x] 3.24 Property test for a reused key with a different body
    - **Property 18: A different body under a reused key is rejected**
    - **Validates: Requirements 6.4**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any key already completed or in progress, a body that canonicalizes differently gives 422 `IDEMPOTENCY_KEY_REUSED` and no new Transaction.
    - _Requirements: 6.4, 21.4, 21.17_
  - [x] 3.25 Property test for concurrent identical requests
    - **Property 19: A concurrent identical request is rejected while in progress**
    - **Validates: Requirements 6.5**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). With the fake clock under 25 s and an IN_PROGRESS record, the same key and body give 409 `IDEMPOTENCY_KEY_IN_PROGRESS` and zero gateway calls.
    - _Requirements: 6.5, 21.4, 21.17_
  - [x] 3.26 Property test for stale in-progress records
    - **Property 20: Stale in-progress records recover without duplicating work**
    - **Validates: Requirements 6.9, 6.10**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). Advance the fake clock beyond 25 s: with a transaction id the repeat answers 200 with that transaction and writes nothing; without one the record is taken over and processed exactly once, also when two requests race for the takeover.
    - _Requirements: 6.9, 6.10, 21.17_
  - [x] 3.27 Property test for key release
    - **Property 21: Pre-write failures leave the idempotency key reusable**
    - **Validates: Requirements 6.11**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any business error before the PENDING Transaction exists, the record is deleted and the next request with the same key is processed as new; after the Delivery is written the record is never released.
    - _Requirements: 6.11, 21.17_
  - [x] 3.28 Property test for provider acceptance on create
    - **Property 24: Provider acceptance updates the transaction according to its reported status (create part)**
    - **Validates: Requirements 7.3, 7.4, 7.5**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over accepted provider create responses: a PENDING status records the External_Id and answers 201 PENDING; a Final_Status runs the Amount_Check and `FinalizeTransaction` before the response and the response carries the resulting status (APPROVED decrements stock once, the declined family leaves it unchanged). The sync part of this property is task 4.14.
    - _Requirements: 7.3, 7.4, 7.5, 21.17_
  - [x] 3.29 Property test for non-retryable provider failure
    - **Property 25: A 4xx on the first attempt marks the transaction ERROR; a 4xx on the retry after an unreachable first attempt stays PENDING for later reconciliation**
    - **Validates: Requirements 7.6, 7.7, 8.1, 8.2**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). A first-attempt 4xx gives Transaction ERROR with the provider message as `statusReason`, Delivery CANCELLED, stock unchanged and 502 `PAYMENT_PROVIDER_ERROR`. A first attempt that times out or returns 5xx followed by a retry 4xx gives 201 PENDING: no External_Id, Delivery PENDING, zero `findByReference` calls and no further gateway call in the request (Requirement 21.15 case). A timeout or 5xx on both attempts gives the same 201 PENDING.
    - _Requirements: 7.6, 7.7, 8.1, 8.2, 21.6, 21.15, 21.17_
  - [x] 3.30 Checkpoint, `feat/HU-09-transactions`
    - Run `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (all four metrics at least 80), `npm run build`, `npm run depcruise`, `bash scripts/check-forbidden-words.sh` (no findings). Run `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` in `infra/`. Do not run `terraform plan` or `terraform apply`.
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 17.6, 19.6, 21.1_
  - [ ] 3.31 **[MANUAL — developer only]** Push, PR, merge, deploy and smoke check
    - Create `feat/HU-09-transactions`, commit in small Conventional Commits (`feat(api): add integrity signature`, `feat(api): add idempotency repository`, `feat(api): add transaction and delivery repositories`, `feat(api): add amount check`, `feat(api): add finalize transaction`, `feat(api): add payment create`, `feat(api): add create transaction use case`, `feat(api): add transactions endpoint`, `feat(infra): raise lambda timeout to 25 s`), push, open the PR, wait for green CI, squash merge to `master`, approve the `production` gate (the CloudFront origin timeout change can take a few minutes to propagate).
    - Smoke check: `bash scripts/smoke-test.sh https://<distribution-domain>`; `curl -s -X POST https://<distribution-domain>/api/v1/transactions -H 'Content-Type: application/json' -d '{}'` returns 400 `MISSING_IDEMPOTENCY_KEY`; the same call with `-H 'Idempotency-Key: smoke-key-0001'` returns 400 `VALIDATION_ERROR`; `curl -s -X POST ... -H 'Content-Type: text/plain'` returns 415. A full approved or declined purchase is verified in the final evidence task.
    - Agents must not run `git commit`, `git push` or `terraform apply`.
    - _Requirements: 19.1, 19.2_

### Branch `feat/HU-11-sync-deliveries`

- [ ] 4. Status sync, reconciliation, deliveries and the finalization properties
  - [ ] 4.1 Payment gateway adapter: getStatus and findByReference
    - Suggested executor: senior.
    - In `payment-gateway.adapter.ts` implement both methods under `withSingleAttemptProfile` (one attempt, 3 s timeout, no retry under any outcome). `getStatus(externalId)`: `GET {PAYMENT_API_URL}/transactions/{externalId}`; map the provider status to `PENDING`, `APPROVED`, `DECLINED`, `VOIDED` or `ERROR` plus the provider message, amount, currency and reference; any other value maps to an explicit `UNKNOWN` outcome that the use case treats as "keep PENDING and warn". `findByReference(reference)` per Open Point D and the Sandbox result recorded in `.kiro/steering/payment-gateway.md` by branch 2: a read-only lookup by our reference; an empty result, a 404 or a null transaction all map to `Ok({ kind: 'not_found' })`; a found record maps to `{ kind: 'found', externalId, status }` with the same provider fields; a timeout, a transport failure or any other HTTP error on the single attempt maps to `Err`. Neither method ever sends a creation request. Secrets and bodies stay out of logs and errors.
    - Tests with `nock` and fake timers: each known status, an unknown status, 4xx and 5xx give `Err` after exactly one request, a hanging response gives `Err` at 3 s with no second request, each not-found shape, the found shape.
    - _Requirements: 4.3, 8.2, 8.3, 8.7, 9.3, 9.7, 9.8, 17.8_
  - [ ] 4.2 SyncTransactionStatus use case
    - Suggested executor: senior.
    - Create `api/src/application/use-cases/sync-transaction-status.ts`: load by id (`TRANSACTION_NOT_FOUND` when missing); a final status returns the stored state with no provider call; PENDING with an External_Id and `lastSyncedAt` at least 1 s old calls `getStatus`, stores `lastSyncedAt` and, for a final status, runs `FinalizeTransaction` with the provider-reported amount, currency and reference (Amount_Check included); younger than 1 s returns the stored state; a provider error or an unknown status keeps PENDING, sends no second request in the same call and writes a `warn` log; PENDING without an External_Id runs `findByReference`: `found` stores the External_Id and applies the status as above, `not_found` at or after 60 s of age runs `FinalizeTransaction` to ERROR with `statusReason` `PROVIDER_UNREACHABLE` (Delivery CANCELLED, stock unchanged, no report so no Amount_Check), `not_found` under 60 s keeps PENDING, a lookup error keeps PENDING with a `warn` log. This use case never calls `PaymentGateway.create`.
    - Tests with fakes and the fake clock for every branch above, including an APPROVED report whose amount differs from the stored total ending ERROR `AMOUNT_MISMATCH` with an alert log, and that exactly one `getStatus` or `findByReference` call is made per invocation.
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 10.9, 10.10, 17.3, 17.4, 21.15_
  - [ ] 4.3 Transaction response mapper, GET controller and wiring
    - Add `TransactionsController.get` (`GET /transactions/:id`) answering `id`, `reference`, `status`, `statusReason` (when present), `amounts`, `deliveryId`, `card { brand, lastFour }`, `productId`, `quantity`, `installments`, `createdAt`, `updatedAt`, `finalizedAt` (when present). Use one shared response mapper for the create and get responses that never includes the External_Id, the card token or card data other than brand and last four. A malformed id gives 404 `TRANSACTION_NOT_FOUND`, never 400 or 500. Add swagger decorators for 200 and 404 and register the use case in `app.module.ts`.
    - supertest tests: full shape, optional fields, 404 for unknown and malformed ids, no `externalId` in the body.
    - _Requirements: 9.1, 9.2, 9.9, 13.9, 18.1_
  - [ ] 4.4 GetDelivery use case, controller and wiring
    - Create `get-delivery.ts` (`null` gives `DELIVERY_NOT_FOUND`) and `DeliveriesController` (`GET /deliveries/:id`) answering `id`, `transactionId`, `productId`, `quantity`, `recipientName`, `phone`, `addressLine1`, `addressLine2` (when present), `city`, `department`, `postalCode` (when present), `status`, `createdAt`, `updatedAt`. A malformed id gives 404. Swagger decorators for 200 and 404; register in `app.module.ts`. Add a test that a Delivery created by `CreateTransaction` carries the `transactionId` of its Transaction.
    - Tests: use case with fakes; supertest 200 shape with and without the optional fields, 404 for unknown and malformed ids.
    - _Requirements: 11.1, 11.2, 13.9, 17.3, 18.1_
  - [ ] 4.5 Scenario test for an unreachable provider
    - Jest test `api/test/scenarios/provider-unreachable.spec.ts` wiring the real use cases to fakes and the real gateway adapter over `nock`: create with a timeout then a 5xx gives 201 PENDING without External_Id; a later `GET` links the External_Id through the reference lookup (one attempt, no retry) without a second creation call; a missing record after 60 s ends ERROR `PROVIDER_UNREACHABLE` with the Delivery CANCELLED and stock unchanged. A second scenario: timeout then a 4xx on the retry gives 201 PENDING with no lookup in the `POST`, then the `GET` reconciles.
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 21.5, 21.15_
  - [ ] 4.6 Property test for no second charge
    - **Property 26: An unreachable Provider never produces a second charge for the same reference**
    - **Validates: Requirements 8.2**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any Reference, across the creation (one call plus at most one retry inside the adapter) and any number of `GET /transactions/:id` calls, `PaymentGateway.create` is invoked at most once.
    - _Requirements: 8.2, 21.17_
  - [ ] 4.7 Property test for reconciliation outcomes
    - **Property 27: Reconciliation outcomes are applied correctly and only when needed**
    - **Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.7**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over transaction age and lookup outcome (`found` with a status, `not_found`, error): the expected External_Id storage, status, `PROVIDER_UNREACHABLE` ERROR at or after 60 s, PENDING otherwise, warning log on error, exactly one lookup attempt per `GET`.
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7, 21.17_
  - [ ] 4.8 Property test for the sync throttle
    - **Property 28: Provider sync is throttled to once per second and skipped once final**
    - **Validates: Requirements 9.3, 9.4, 9.6**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over sequences of `GET` calls with advancing fake time: a provider call only when `lastSyncedAt` is at least 1 s old (and `lastSyncedAt` is updated), and none after a final status.
    - _Requirements: 9.3, 9.4, 9.6, 21.17_
  - [ ] 4.9 Property test for unknown provider statuses
    - **Property 29: Unrecognized Provider status values are rejected safely**
    - **Validates: Requirements 9.8**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any string outside the five known statuses, the Transaction stays PENDING, a warning is logged and the response is a normal 200 with a known status.
    - _Requirements: 9.8, 21.17_
  - [ ] 4.10 Property test for finalization side effects
    - **Property 30: Finalization applies the correct side effects per outcome**
    - **Validates: Requirements 10.1, 10.2, 10.4**
    - `fast-check` with `numRuns: 100` (use-case and adapter level with `aws-sdk-client-mock`, no HTTP). For any PENDING transaction and final status whose Amount_Check matches: APPROVED gives Transaction APPROVED, Delivery ASSIGNED, `stock -= quantity`; DECLINED, VOIDED and ERROR give the same status, Delivery CANCELLED, unchanged stock, the provider message as `statusReason`; `finalizedAt` is always set.
    - _Requirements: 10.1, 10.2, 10.4, 21.7, 21.17_
  - [ ] 4.11 Property test for finalization idempotency
    - **Property 31: Finalization is idempotent**
    - **Validates: Requirements 10.6**
    - `fast-check` with `numRuns: 100` (use-case and adapter level with `aws-sdk-client-mock`, no HTTP). Running `FinalizeTransaction` N times with any statuses on one transaction leaves the same stock, Delivery status and Transaction status as the first call, and never decrements twice.
    - _Requirements: 10.6, 21.7, 21.17_
  - [ ] 4.12 Property test for backorder and concurrency
    - **Property 33: Approval without enough stock produces BACKORDER, never negative stock**
    - **Validates: Requirements 10.5, 10.8**
    - `fast-check` with `numRuns: 100` (use-case and adapter level, no HTTP). APPROVED with `stock < quantity` gives Transaction APPROVED, Delivery BACKORDER, stock unchanged and an alert log with the Reference and product id; N interleaved finalizations of different transactions on one product never take stock below 0 (use the in-memory repository with conditional semantics and a `fast-check` scheduler).
    - _Requirements: 10.5, 10.8, 21.7, 21.17_
  - [ ] 4.13 Property test for the Amount_Check gate
    - **Property 46: Amount_Check gates finalization, overriding even an APPROVED report**
    - **Validates: Requirements 10.9, 10.10, 10.11**
    - `fast-check` with `numRuns: 100` (pure function plus use-case level with in-memory fakes, no HTTP). Part one, `checkAmount`: over arbitrary reported and stored triples, the result is `match` if and only if the amount, currency and reference are all equal, and a mismatch lists exactly the differing fields. Part two, `FinalizeTransaction` with fakes, driven through the `CreateTransaction` and the `SyncTransactionStatus` callers: for any reported status (including APPROVED) with at least one differing field the result is ERROR with `statusReason` `AMOUNT_MISMATCH`, Delivery CANCELLED, unchanged stock and an alert log naming the Reference and the differing fields; for a report that matches exactly, the reported status is applied as in Property 30. The webhook caller is covered by tasks 6.3 and 6.7.
    - _Requirements: 10.9, 10.10, 10.11, 21.15, 21.17_
  - [ ] 4.14 Property test for provider acceptance on sync
    - **Property 24: Provider acceptance updates the transaction according to its reported status (sync part)**
    - **Validates: Requirements 9.5**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over provider statuses returned to `GET /transactions/:id`: a PENDING status keeps PENDING, a Final_Status runs the Amount_Check and `FinalizeTransaction` before the response, and the stored result equals the result of the same status arriving on create (task 3.28). The create part of this property is task 3.28.
    - _Requirements: 9.5, 21.17_
  - [ ] 4.15 Property test for the Single_Attempt_Profile at adapter level
    - **Property 9: Provider resilience policy is profile-specific (Single_Attempt_Profile part)**
    - **Validates: Requirements 8.3, 9.3**
    - `fast-check` with `numRuns: 100` (adapter level, `nock` and fake timers, no HTTP) over simulated provider outcomes (success, not found, 4xx, 5xx, timeout): through the real `getStatus` and `findByReference`, exactly one request is made with a 3 s timeout and never a retry, regardless of the outcome; a "no record" answer is a successful `not_found`, not a retry trigger. The policy and Standard_Profile part of this property is task 2.11.
    - _Requirements: 8.3, 9.3, 21.15, 21.17_
  - [ ] 4.16 Property test for fetching existing resources
    - **Property 2: Fetching an existing resource returns it with its documented shape**
    - **Validates: Requirements 1.5, 3.9, 9.1, 9.9, 11.1**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over generated Products, Customers, Transactions and Deliveries behind the real controllers with in-memory fakes: `GET .../:id` answers 200 with exactly the documented field set, and the Transaction body never has `externalId`, a card token or card data beyond brand and last four.
    - _Requirements: 1.5, 3.9, 9.1, 9.9, 11.1, 21.17_
  - [ ] 4.17 Property test for unknown ids
    - **Property 3: An id that matches no record always yields the resource's not-found code**
    - **Validates: Requirements 1.6, 3.10, 9.2, 11.2**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over arbitrary id strings (valid ULIDs that do not exist, garbage, very long, unicode) for the four resources: 404 with that resource's code and never 500.
    - _Requirements: 1.6, 3.10, 9.2, 11.2, 21.17_
  - [ ] 4.18 Property test for no throwing on business failures
    - **Property 42: Use cases and adapters never throw for business failures**
    - **Validates: Requirements 17.4**
    - `fast-check` with `numRuns: 100` (use-case level with in-memory fakes, no HTTP). Table-driven over every non-webhook use case (`GetProducts`, `GetProduct`, `GetFees`, `UpsertCustomer`, `GetCustomer`, `GetAcceptanceTokens`, `CreateTransaction`, `SyncTransactionStatus`, `FinalizeTransaction`, `GetDelivery`) and every repository or gateway adapter, with inputs that trigger each documented business error: the call always resolves to `Err`, never a rejected promise or a thrown exception. `HandlePaymentEvent` is not part of this property: its no-throw rule is checked by the example tests of task 6.3.
    - _Requirements: 17.4, 21.17, 21.18_
  - [ ] 4.19 Checkpoint, `feat/HU-11-sync-deliveries`
    - Run `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (all four metrics at least 80), `npm run build`, `npm run depcruise`, `bash scripts/check-forbidden-words.sh` (no findings). No infra change in this branch.
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 17.6, 21.1_
  - [ ] 4.20 **[MANUAL — developer only]** Push, PR, merge, deploy and smoke check
    - Create `feat/HU-11-sync-deliveries`, commit in small Conventional Commits (`feat(api): add payment status and reference lookup`, `feat(api): add sync transaction status`, `feat(api): add get transaction endpoint`, `feat(api): add get delivery endpoint`, `test(api): add finalization and amount check properties`, `test(api): add resource lookup properties`), push, open the PR, wait for green CI, squash merge to `master`, approve the `production` gate.
    - Smoke check: `bash scripts/smoke-test.sh https://<distribution-domain>`; `curl -s https://<distribution-domain>/api/v1/transactions/unknown` returns 404 `TRANSACTION_NOT_FOUND`; `curl -s https://<distribution-domain>/api/v1/deliveries/unknown` returns 404 `DELIVERY_NOT_FOUND`.
    - Agents must not run `git commit` or `git push`.
    - _Requirements: 8.3, 9.1, 11.2_

### Branch `feat/HU-19-docs-rate-limit`

- [ ] 5. OpenAPI, docs site, rate limit by client IP and the `/api/*` origin request policy
  - [ ] 5.1 OpenAPI generation script
    - Create `api/scripts/generate-openapi.ts` and the npm script `openapi`: build the Nest application with the real controllers and fake or stub providers (no network port opened, no AWS call, no provider call, no SSM read), call `SwaggerModule.createDocument`, add the Error_Envelope schema and the error codes from `ERROR_CATALOG`, and write `docs/openapi.json` with recursively sorted keys, two-space indent, trailing newline and no timestamps so two runs are identical. The API runtime never calls `SwaggerModule.setup`.
    - Jest test `api/test/docs/openapi.spec.ts`: running the generator twice gives identical bytes; every method and path of the API contract table that exists at this point (every endpoint except the optional webhook, which task 6.4 adds to the check) is present with its documented status codes (including 415, 429 and the `Idempotency-Key` header on `POST /transactions`); the document contains no secret-like value; a scan of `api/src` finds no `SwaggerModule.setup`.
    - Commit the generated `docs/openapi.json`.
    - _Requirements: 18.1, 18.2, 18.3, 18.4_
  - [ ] 5.2 Docs site build script
    - Create `api/scripts/build-docs-site.ts` and the npm script `docs:site`: assemble `docs/site/` from the `swagger-ui-dist` assets, an `index.html` without inline scripts, inline styles or `style=` attributes (script and stylesheet loaded from `/docs/...` same-origin files, the initializer generated by the script as a static file pointing at `/docs/openapi.json`) and a copy of `docs/openapi.json`. Add `docs/site/` to `.gitignore`.
    - Jest test `api/test/docs/docs-site.spec.ts`: builds into a temp directory, asserts the files exist, the index has no inline `<script>` body, no `<style>`, no `style=` attribute and no `data:` URL, and every asset reference is relative to `/docs/`.
    - _Requirements: 18.5, 18.11_
  - [ ] 5.3 CI check that `docs/openapi.json` is current
    - In `.github/workflows/ci.yml` add a step in the API job after the tests: run `npm run openapi` and `git diff --exit-code -- ../docs/openapi.json` so CI fails when the committed file differs. Keep the workflow permissions and the existing steps.
    - Static Jest test (extend or add under `api/test/infra/`): the `ci` workflow contains the regeneration step and the diff check, and no step uses AWS credentials.
    - _Requirements: 18.6_
  - [ ] 5.4 Terraform: docs index function, behaviors and headers policy
    - `infra/cloudfront_function.tf`: add the guard for `/docs/` to `spa_rewrite` (same shape as the `/api/` guard, between the `SPA_REWRITE_START/END` markers) and the new function `docs_index_rewrite` with the markers `DOCS_INDEX_REWRITE_START/END`, as in the design. `infra/cloudfront_headers.tf`: extract the shared header values into `locals` and add `aws_cloudfront_response_headers_policy.docs`, identical to the security policy except the CSP directive `img-src 'self' data:`. `infra/cloudfront.tf`: add two `ordered_cache_behavior` blocks, `/docs` and `/docs/*`, before the `/api/*` block, targeting the S3 origin with the docs headers policy and the `docs_index_rewrite` function. Run `terraform fmt`.
    - Extend `api/test/infra/terraform-static.spec.ts` (text checks): both behaviors exist before `/api/*`, use the docs policy and `docs_index_rewrite`, never `spa_rewrite`; the docs policy differs from the security policy only in `img-src`.
    - _Requirements: 18.7, 18.9, 18.10, 19.6_
  - [ ] 5.5 Pipeline: docs sync, web sync exclusion, invalidation and smoke test
    - `.github/workflows/deploy.yml` (`deploy-web` job): add `--exclude "docs/*"` to the web `aws s3 sync ... --delete`; add Node 22 setup, `npm ci` in `api/` and `npm run docs:site`; add a separate docs sync step `aws s3 sync docs/site "s3://$WEB_BUCKET/docs" --delete` followed by an `aws s3 cp` of `openapi.json` with `--cache-control no-cache`; make the invalidation paths include `/docs/*`. Keep OIDC only, `environment: production`, no artifacts, no secrets.
    - `scripts/smoke-test.sh`: add checks that `/docs/` and `/docs/openapi.json` answer 200 and that the `content-security-policy` of `/docs/` contains `img-src 'self' data:`. Update `api/test/scripts/smoke-test.spec.ts` and `api/test/infra/deploy-workflow.spec.ts` (job order, permissions, no artifact, sync exclusion, docs step, invalidation).
    - _Requirements: 18.12, 18.13, 18.14, 18.15_
  - [ ] 5.6 Postman collection
    - Create `api/scripts/generate-postman.ts` and the npm script `postman`: converts `docs/openapi.json` into `docs/postman/payments-api.postman_collection.json` (variables `baseUrl`, `originVerify` left empty, no secret values, `Idempotency-Key` header on the create request, one example per endpoint, requests grouped by resource). Deterministic output, committed.
    - Jest test `api/test/docs/postman.spec.ts`: valid collection JSON, every OpenAPI operation has a request, no secret-like value, no forbidden word, and regenerating gives the committed bytes.
    - _Requirements: 18.1_
  - [ ] 5.7 Client IP derivation
    - Create `api/src/infrastructure/http/security/client-ip.ts`: `deriveClientIp(headerValue, socketAddress)` splits `CloudFront-Viewer-Address` at the last `:` and keeps everything before it (IPv4:port and IPv6 with or without brackets and port); a missing header or a value without `:` returns the socket address. `X-Forwarded-For` is never read anywhere.
    - Tests: IPv4 value, IPv6 value with port, missing header, value without a colon, and a client-sent `X-Forwarded-For` with no effect.
    - _Requirements: 15.3, 15.4, 15.5, 15.6, 21.10_
  - [ ] 5.8 Rate limiter module and guard, `GET /health` excluded
    - Create `api/src/infrastructure/http/security/rate-limit.module.ts` (wiring only): `ThrottlerModule.forRoot` with one throttler of 60 requests per 60 s, `getTracker` using `deriveClientIp(req.headers['cloudfront-viewer-address'], req.socket.remoteAddress)`, in-memory storage, and a global `APP_GUARD` of `ThrottlerGuard`. Add `@SkipThrottle()` to `HealthController.check` so `GET /api/v1/health` is never counted and never answered 429. Map the throttler exception to 429 `TOO_MANY_REQUESTS` with the fixed message through the existing filter. Confirm Express `trust proxy` stays disabled and add a test for it. Import the module in `app.module.ts`.
    - supertest tests: the 61st request in 60 s from one IP is 429, a different IP has its own counter, the window resets with fake timers, the 429 body is the standard envelope with `X-Request-Id`; 100 `GET /api/v1/health` requests from one IP all answer 200 and never 429, and after them 60 requests to `/api/v1/fees` from the same IP still pass and the 61st is 429 (health did not consume the budget).
    - _Requirements: 15.1, 15.2, 15.6, 15.7, 15.12, 21.9, 21.15_
  - [ ] 5.9 Terraform and pipeline: custom `/api/*` origin request policy as the only policy
    - `infra/cloudfront.tf`: remove the data source `all_viewer_except_host_header` and add `aws_cloudfront_origin_request_policy.api` as in Open Point B: header behavior `whitelist` with exactly `CloudFront-Viewer-Address`, `Content-Type`, `Accept`, `Idempotency-Key`, `X-Event-Checksum` and `X-Request-Id`; `query_string_behavior = "all"`; `cookie_behavior = "none"`; never `Host`. The `/api/*` behavior sets `origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id` directly. `X-Origin-Verify` stays an origin custom header. Declare no variable and no local that selects an origin request policy, and pass none from `.github/workflows/deploy.yml`. Run `terraform fmt`.
    - Update every existing assertion in `api/test/infra/terraform-static.spec.ts` that expects the removed data source. New static Jest test `api/test/infra/origin-request-policy.spec.ts` (reads `infra/*.tf` and `.github/workflows/deploy.yml` as text): the header whitelist is exactly the six names (set equality) and has no `Host`; `cookie_behavior = "none"`; `query_string_behavior = "all"`; the `/api/*` behavior references the custom resource; `infra/` contains no `data "aws_cloudfront_origin_request_policy"` and no variable whose name contains `origin_request_policy`; `deploy.yml` passes no variable to Terraform whose name contains `origin_request_policy`. Confirm the existing smoke test already requires `GET /api/v1/health` to answer 200.
    - _Requirements: 15.8, 15.9, 15.10, 15.11, 19.6, 21.14_
  - [ ] 5.10 Steering docs, deployment docs and README links
    - `.kiro/steering/api-contract.md`: full endpoint table (the webhook row marked "optional, available only after branch 6 merges"), the 17 error codes and statuses, the 201 PENDING behavior (provider unreachable after the retry, and a 4xx on the retry after a first attempt that ended in timeout or 5xx) and the meaning of 502 `PAYMENT_PROVIDER_ERROR` on `POST /transactions` (provider 4xx on the first creation attempt), its responses 201, 200, 400, 404, 409, 415, 422, 429, 502, the response shapes of `acceptance-tokens`, `fees` and `products`, the rate limit key `CloudFront-Viewer-Address` with `GET /api/v1/health` excluded, the Docs_Site under `/docs/`, the `statusReason` values `PROVIDER_UNREACHABLE` and `AMOUNT_MISMATCH` with their meaning, the rule that a `POST` accepts `application/json` with or without `charset=utf-8` and answers 415 `UNSUPPORTED_MEDIA_TYPE` for any other media type or charset, and the rule that a body with an amount property is rejected with 400 (replacing "client-sent amounts are ignored").
    - `.kiro/steering/payment-gateway.md`: Resilience section gains the 201 PENDING behavior, reconciliation by Reference, the 60 s window with reason `PROVIDER_UNREACHABLE`, the Standard_Profile and the Single_Attempt_Profile, the Amount_Check with reason `AMOUNT_MISMATCH`, and the reference-lookup assumption note of Open Point D next to the Sandbox result recorded in branch 2.
    - `docs/deployment.md`: add the `/docs/` and `openapi.json` checks to the Verification section. `README.md`: link to `/docs/`, `docs/openapi.json` and the Postman collection, in English, without the provider name.
    - Jest content test `api/test/docs/api-contract-docs.spec.ts`: every code of Requirement 13 criterion 3 is listed with its status; `PROVIDER_UNREACHABLE`, `AMOUNT_MISMATCH`, `charset=utf-8`, `CloudFront-Viewer-Address` and the health exclusion are present; the Resilience section names both profiles; `.kiro/steering/payment-gateway.md` has the heading "Reference lookup (Sandbox result)"; `docs/deployment.md` and `README.md` have no seed step; no forbidden word, no `prv_`.
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8, 19.5, 16.8_
  - [ ] 5.11 Property test for the SPA rewrite function
    - **Property 44: The SPA rewrite function is provably inert for `/api/` and `/docs/`**
    - **Validates: Requirements 18.8**
    - `fast-check` with `numRuns: 100` (pure function). Extend the oracle in `api/test/infra/spa-rewrite.spec.ts` (function body extracted between the markers and evaluated): for any URI starting with `/api/` or `/docs/` the request is unchanged; any other extension-less URI becomes `/index.html`.
    - _Requirements: 18.8, 21.17_
  - [ ] 5.12 Property test for the docs index function
    - **Property 45: The docs index function rewrites only the two bare docs paths**
    - **Validates: Requirements 18.9**
    - `fast-check` with `numRuns: 100` (pure function). New `api/test/infra/docs-index-rewrite.spec.ts` with the same evaluation helper: the URI becomes `/docs/index.html` if and only if it is exactly `/docs` or `/docs/`; every other URI, including real assets under `/docs/`, is unchanged.
    - _Requirements: 18.9, 21.17_
  - [ ] 5.13 Property test for client IP parsing
    - **Property 41: Client IP parsing splits at the last colon, with a safe fallback**
    - **Validates: Requirements 15.3, 15.4, 15.5, 15.6, 21.10**
    - `fast-check` with `numRuns: 100` (pure function) over IPv4:port and IPv6[:port] strings: the result is everything before the last `:`; values without `:` and an absent header return the socket address; a random `X-Forwarded-For` header never changes the result.
    - _Requirements: 15.3, 15.4, 15.5, 15.6, 21.10, 21.11, 21.17_
  - [ ] 5.14 Property test for the rate limiter
    - **Property 40: The rate limiter enforces exactly 60 requests per 60 s per Client_IP, and never counts `GET /health`**
    - **Validates: Requirements 15.1, 15.2, 15.12**
    - `fast-check` with `numRuns: 25` (HTTP, supertest) over request counts and IP sets within one window: the first 60 per IP pass, later ones are 429 `TOO_MANY_REQUESTS`, other IPs are independent; any number of `GET /api/v1/health` requests from the same IP in the window are never counted and never answered 429.
    - _Requirements: 15.1, 15.2, 15.12, 21.15, 21.17_
  - [ ] 5.15 Checkpoint, `feat/HU-19-docs-rate-limit`
    - Run `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (all four metrics at least 80), `npm run build`, `npm run depcruise`, `npm run openapi` (no diff in `docs/openapi.json`), `npm run postman` (no diff), `npm run docs:site`, `bash scripts/check-forbidden-words.sh` (no findings). Run `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` in `infra/`. Do not run `terraform plan` or `terraform apply`.
    - Read the four coverage metrics: they must be at least 90 here, because branches 1 to 5 carry their own example tests for everything they ship and branch 6 can still be left out.
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 18.6, 19.6, 21.1_
  - [ ] 5.16 **[MANUAL — developer only]** Push, PR, merge, deploy and smoke check
    - Create `feat/HU-19-docs-rate-limit`, commit in small Conventional Commits (`feat(api): add openapi generation`, `feat(api): add docs site build`, `ci: check openapi document is current`, `feat(infra): add docs behaviors and headers policy`, `ci: sync docs site on deploy`, `docs: add postman collection`, `feat(api): add client ip derivation`, `feat(api): add rate limit`, `feat(infra): use custom api origin request policy`, `docs: update api contract`), push, open the PR, wait for green CI, squash merge to `master`, approve the `production` gate (new CloudFront behaviors and the origin request policy change can take several minutes).
    - Smoke check: `bash scripts/smoke-test.sh https://<distribution-domain>` (includes the new `/docs/` checks and `GET /api/v1/health` answering 200); open `https://<distribution-domain>/docs/` and `https://<distribution-domain>/docs` in a browser: the endpoint list renders and the browser console shows zero Content-Security-Policy violations.
    - Confirm the rate limit: 61 quick `curl` calls to `/api/v1/fees` from one machine end with 429 `TOO_MANY_REQUESTS`; 100 quick `curl` calls to `/api/v1/health` all answer 200. If `GET /api/v1/health` answers 403 right after the policy change, stop and report it: the fix is a change to the header whitelist in `infra/cloudfront.tf` in a new PR.
    - Agents must not run `git commit`, `git push` or `terraform apply`.
    - _Requirements: 15.9, 15.12, 18.11, 18.15_

### Branch `feat/HU-13-payment-webhook`

- [ ] 6. Payment event webhook (optional branch, cut first if late; comes after docs and rate limit, before the evidence branch)
  - [ ] 6.1 Event checksum
    - Suggested executor: senior.
    - Create `api/src/infrastructure/payment/event-checksum.ts`: `computeEventChecksum(signatureProperties, timestamp, secret)` returns `sha256hex` of the values of `signature.properties` read from the event data in order, then the `timestamp`, then the events secret; `verifyEventChecksum(computed, provided)` uses the existing `timing-safe-equal.ts` helper and returns false for a missing value or a length mismatch without throwing.
    - Tests: a fixed known vector with fake secret and fake event data, nested property paths, missing property, wrong length, equal and different checksums.
    - _Requirements: 12.2, 12.3, 21.3_
  - [ ] 6.2 Event checksum verifier port, fake and adapter
    - Create the port `api/src/application/ports/event-checksum-verifier.ts` (`verify(event, headerChecksum): ResultAsync<boolean, PaymentGatewayError>`, `Ok(false)` for a missing or mismatched checksum) and the fake `api/test/support/fake-event-checksum-verifier.ts`. Create `api/src/infrastructure/payment/event-checksum-verifier.adapter.ts` implementing the port: reads the secret from `PAYMENT_EVENTS_SECRET_PARAM` with the cached SSM reader of task 2.6, picks the candidate from the `X-Event-Checksum` header when present and otherwise from `signature.checksum` of the body, and compares in constant time. A missing candidate or a secret read failure returns an error value, never throws.
    - Tests with `aws-sdk-client-mock` (SSM): header preferred over body, body fallback, mismatch, missing, secret never in an error or log.
    - _Requirements: 12.2, 12.3, 12.4, 17.7, 17.10_
  - [ ] 6.3 HandlePaymentEvent use case
    - Suggested executor: senior.
    - Create `api/src/application/use-cases/handle-payment-event.ts`: verify the checksum through the port first (`INVALID_SIGNATURE` and no state change on failure); an event type other than `transaction.updated` returns `Ok` with no change; find the Transaction by Reference (unknown gives `Ok` plus a `warn` log); a final stored status that differs from the event status gives `Ok` plus a `warn` log with no change; a PENDING Transaction without External_Id stores the External_Id from the event first; then, for a Final_Status event, apply the event status through `FinalizeTransaction` with the event amount, currency and reference, so the same Amount_Check runs as on the create and sync paths (a mismatch ends ERROR `AMOUNT_MISMATCH`); a PENDING event only records the External_Id. Return a discriminated outcome used only for logging; the HTTP answer is 200 in every valid case.
    - Example tests with fakes (these keep the branch above the coverage gate without the optional property tests): each branch above, an APPROVED event with a different amount ending ERROR `AMOUNT_MISMATCH` with an alert log and unchanged stock, no provider call and no creation call, and that a rejecting repository or verifier fake yields an `Err` value and never a thrown exception (Requirement 17.10).
    - _Requirements: 10.9, 10.10, 12.1, 12.4, 12.5, 12.6, 12.7, 12.8, 17.3, 17.4, 17.10, 21.8_
  - [ ] 6.4 Webhook DTO, controller, wiring and regenerated documents
    - Create `payment-event.dto.ts` (declares `event`, `data`, `signature { properties, checksum }`, `timestamp`; accepts undeclared properties) and `WebhooksController` (`POST /webhooks/payments`) with a per-route `ValidationPipe` that sets `forbidNonWhitelisted: false`, reads `X-Event-Checksum`, answers 200 and maps `INVALID_SIGNATURE` to 401. The origin guard already protects the route. Swagger decorators for 200 and 401; register the use case and the verifier in `app.module.ts`.
    - Regenerate and commit `docs/openapi.json` (`npm run openapi`) and `docs/postman/payments-api.postman_collection.json` (`npm run postman`), since the CI check of branch 5 fails on a stale document; add the webhook method and path to the contract check in `api/test/docs/openapi.spec.ts`; remove the "optional" mark from the webhook row of `.kiro/steering/api-contract.md`.
    - supertest example tests: valid event 200, bad or missing checksum 401 with no state change, unknown Reference 200, extra undeclared property accepted, missing `X-Origin-Verify` 403.
    - _Requirements: 12.1, 12.3, 12.4, 12.9, 14.2, 18.1, 18.6, 21.8, 21.18_
  - [ ]* 6.5 Property test for the event checksum formula
    - **Property 23: Integrity signature and event checksum match their formulas (event checksum part)**
    - **Validates: Requirements 12.2, 21.3**
    - `fast-check` with `numRuns: 100` (pure function) over `(properties, timestamp, secret)` tuples: `computeEventChecksum` equals an independently written `sha256hex` of the values concatenated in order; the fixed known vector stays as an example. The integrity signature part of this property is task 3.13.
    - _Requirements: 12.2, 21.3, 21.17_
  - [ ]* 6.6 Property test for the checksum gate
    - **Property 34: Webhook checksum gates every state change**
    - **Validates: Requirements 12.3, 12.4**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any body and any candidate checksum (header or body), only an exact match is processed; every other case gives 401 `INVALID_SIGNATURE` and the stored state is untouched.
    - _Requirements: 12.3, 12.4, 21.8, 21.17_
  - [ ]* 6.7 Property test for webhook side effects
    - **Property 35: Webhook events apply Finalization exactly once, tolerate undeclared properties, and never move a transaction backward**
    - **Validates: Requirements 12.1, 12.5, 12.6, 12.7, 12.8, 12.9**
    - `fast-check` with `numRuns: 25` (HTTP, supertest). For any valid event: a PENDING Transaction runs the Amount_Check and Finalization before the 200 (a mismatch ends ERROR `AMOUNT_MISMATCH`); an unknown Reference gives 200 and no change; a stored final status that differs from the event gives 200, a warning and no change; PENDING without External_Id stores the External_Id; another event type gives 200 and no change; an undeclared extra property is processed as if absent. With Property 34 (task 6.6) this is one of the two HTTP properties of the branch, and the unknown-property rejection, create-and-sync handling and no-throw properties stay in branches 2, 3 and 4.
    - _Requirements: 10.9, 12.1, 12.5, 12.6, 12.7, 12.8, 12.9, 21.17, 21.18_
  - [ ] 6.8 Checkpoint, `feat/HU-13-payment-webhook`
    - Run `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (all four metrics at least 80), `npm run build`, `npm run depcruise`, `npm run openapi` and `npm run postman` (no diff), `bash scripts/check-forbidden-words.sh` (no findings). No infra change in this branch.
    - Confirm that the coverage of the whole `api/` project stays at or above 80 (working target 90) when the optional property sub-tasks 6.5 to 6.7 are skipped.
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 17.6, 18.6, 21.1_
  - [ ] 6.9 **[MANUAL — developer only]** Push, PR, merge, deploy and smoke check
    - Skip this task and the whole branch if the time is short: polling (branch 4) is the primary path for final statuses and the evidence branch does not depend on the webhook.
    - Create `feat/HU-13-payment-webhook`, commit in small Conventional Commits (`feat(api): add event checksum`, `feat(api): add handle payment event`, `feat(api): add payment webhook endpoint`, `docs: regenerate openapi and postman`, `test(api): add webhook properties`), push, open the PR, wait for green CI, squash merge to `master`, approve the `production` gate.
    - Smoke check: `bash scripts/smoke-test.sh https://<distribution-domain>`; `curl -s -X POST https://<distribution-domain>/api/v1/webhooks/payments -H 'Content-Type: application/json' -d '{"event":"transaction.updated"}'` returns 401 `INVALID_SIGNATURE`.
    - Optional: register `https://<distribution-domain>/api/v1/webhooks/payments` as the events URL in the sandbox dashboard. Polling stays the primary path.
    - Agents must not run `git commit` or `git push`.
    - _Requirements: 12.4_

### Branch `docs/payments-api-evidence`

- [ ] 7. Deployed end-to-end evidence
  - [ ] 7.1 Evidence script and its tests
    - Create `api/scripts/collect-evidence.ts` and the npm script `evidence` (`tsx scripts/collect-evidence.ts`), with exported pure pieces (`runEvidence(deps)`, `renderEvidence(results)`) and a `main` guard. Inputs come only from environment variables: `EVIDENCE_BASE_URL` (the CloudFront URL, must start with `https://`), `PAYMENT_API_URL` and `PAYMENT_PUBLIC_KEY` (public key only; the script never reads a private key or a secret). A missing variable exits non-zero naming the variable. Keys are never printed, written or put in a URL of the output.
    - Flow against the deployed API: list products and pick one with stock of at least 3 (`stock` before); upsert a customer; read the acceptance tokens; tokenize card `4242 4242 4242 4242` and card `4111 1111 1111 1111` directly at the payment sandbox (card data goes only to the tokenization endpoint, never to our API); create an approved purchase (quantity 1, installments 1, a fresh `Idempotency-Key`) and poll `GET /transactions/:id` every 2 s for up to 60 s until a final status; check stock decreased by exactly 1; create the declined purchase with the second card, poll, check status DECLINED and stock unchanged; replay the approved request with the same key and body and check 200, the same transaction id, one transaction only and stock decreased only once; send the same key with a different body and check 422 `IDEMPOTENCY_KEY_REUSED`.
    - Write `docs/evidence/payments-api.md`: date, base URL, a table of checks with result (pass or fail), HTTP statuses, transaction ids and references, stock before and after, card brand and last four only. The output never contains a token, a key, a full card number, a CVC or the provider name; the script exits non-zero if any check fails and still writes the report.
    - Jest tests `api/test/scripts/collect-evidence.spec.ts` with `nock` and an injected clock and sleep: all-pass flow, a failing check marks the report and exits non-zero, missing variables, the rendered Markdown contains no token or key patterns (`prv_`, `pub_`, 16-digit numbers) and no forbidden word, and card data is only sent to the tokenization host.
    - _Requirements: 5.14, 6.6, 6.7, 7.4, 7.5, 9.1, 10.1, 10.2, 21.12_
  - [ ] 7.2 Checkpoint, `docs/payments-api-evidence`
    - Run `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (all four metrics at least 80), `npm run build`, `npm run depcruise`, `bash scripts/check-forbidden-words.sh` (no findings). No infra change in this branch.
    - Report the four coverage metrics (working target 90, with or without branch 6).
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 17.6, 21.1_
  - [ ] 7.3 **[MANUAL — developer only]** Run the evidence script on the deployed environment and merge
    - Preconditions: branches 1 to 5 merged and deployed (branch 6 only if you delivered it), the three payment secrets present in SSM. The catalog comes from the Terraform items of task 1.15.
    - In your own terminal, export the values from your git-ignored `.env` and run in `api/`: `EVIDENCE_BASE_URL=https://<distribution-domain> PAYMENT_API_URL=<sandbox-url> PAYMENT_PUBLIC_KEY=<public-key> npm run evidence`. Never paste keys into the repository, a chat or an agent session.
    - Open `docs/evidence/payments-api.md` and confirm: approved purchase with card 4242… ends APPROVED and stock decreased by exactly 1; declined purchase with card 4111… ends DECLINED and stock unchanged; replay with the same `Idempotency-Key` returns 200 with the same transaction id and no second decrement; different body with the same key returns 422. Run `bash scripts/check-forbidden-words.sh` and `gitleaks` locally on the file.
    - Create `docs/payments-api-evidence`, commit `docs(api): add deployed end-to-end evidence`, push, open the PR, wait for green CI, squash merge to `master`. A docs-only merge may start `deploy.yml`: approve it or let it wait.
    - Agents must not run `git commit` or `git push`, and must not run the script against the deployed environment.
    - _Requirements: 6.7, 7.4, 7.5, 10.1, 10.2_

## Notes

- Suggested branches: the seven branches of the overview, one pull request each, squash merge to `master`, in the order of the table. Manual tasks (`1.24`, `2.13`, `3.31`, `4.20`, `5.16`, `6.9`, `7.3`) are never executed by agents. Agents report readiness and stop at them. Branch 6 is optional: the plan is complete without it.
- Agents only run `terraform fmt`, `terraform init -backend=false` and `terraform validate`. Apply happens only inside `deploy.yml` after approval on `production`. The single recurring manual infrastructure step is the one-time `infra/bootstrap` re-apply of task `1.24`, done by the Developer before merging branch 1: it adds `dynamodb:Scan` to the Lambda permissions boundary and `PutItem`, `GetItem` and `DeleteItem` on the products table to the Deploy_Role, in the same change.
- Placement notes, kept small and flagged for review: (a) one extra port, `ApplicationLogger`, in branch 1, so use cases can write warning and alert logs without importing infrastructure; the `EventChecksumVerifier` port is created in branch 6 (task `6.2`), so cutting that branch leaves no unused port; (b) `ProductRepository` has no stock-decrement method because stock only changes inside `TransactionRepository.finalize`; (c) the finalization core and the Amount_Check (domain function `amount-check.ts`, task `3.6`, and its use inside `FinalizeTransaction`, task `3.7`) land in branch 3, because creating a transaction with a final provider answer (Requirement 7.5) must already run the check and no finalization path may exist without it; branch 4 keeps the sync wiring tests, the Amount_Check property (Property 46) and the finalization properties; (d) the `findByReference` adapter method of `PaymentGateway` is implemented in branch 4 together with `getStatus` (task `4.1`), because `CreateTransaction` no longer reconciles inline and branch 3 would otherwise leave the method unused; its port and fake exist from branch 1; (e) the `dynamodb:Scan` grant and the seed-item grant land in branch 1 so `GET /products` works on the first deploy; (f) the rate limiter and the `/api/*` origin request policy land together in branch 5 so the limiter keys on a real client address from its first deploy; (g) `.kiro/steering/structure.md` and `.kiro/steering/tech.md` each lose one seed-script mention in task `1.15`, nothing else in those files changes.
- The seed `imageUrl` values (`/images/*.webp`) must match the files the `checkout-web` spec adds under `web/public/images/`. Until then the deployed catalog shows broken images, which does not affect the API checks.
- Properties split across branches so that every property is covered by a non-webhook task and the webhook branch keeps only webhook properties: Property 8 in tasks `2.10` (customers) and `3.16` (transactions); Property 9 in tasks `2.11` (policy and Standard_Profile) and `4.15` (Single_Attempt_Profile); Property 23 in tasks `3.13` (integrity signature) and `6.5` (event checksum, optional); Property 24 in tasks `3.28` (create) and `4.14` (sync); Property 42 in task `4.18`; Properties 34 and 35 in tasks `6.6` and `6.7` (optional). Properties 2, 3, 7 and 8 are verified once every resource they cover exists. Property 36 iterates `ERROR_CATALOG`, so codes added later are covered without editing the test.
- Run counts: properties that send requests through HTTP with `supertest` use `numRuns: 25`; pure-function properties (12, 22, 23, 32, 39, 41, 44, 45), the adapter-level and use-case-level properties (4, 9, 30, 31, 33, 42, 43) and Property 46 use `numRuns: 100`. Each task states its value.
- Properties 44 and 45 evaluate the CloudFront Function bodies extracted from Terraform between markers. Properties 1–3, 5–8, 10, 11, 13–21, 24–29, 34–38 and 40 use supertest with fake application layers.
- Requirement coverage notes: 21.4 by Properties 17, 18 and 19; 21.5 by tasks `4.5`; 21.6 by Property 25; 21.7 by Properties 30, 31 and 33; 21.8 by tasks `6.3`, `6.4` and `6.6`; 21.9 by tasks `1.8`, `1.9` and `5.8`; 21.10 by task `5.7`; 21.14 by tasks `1.14`, `1.15` and `5.9`; 21.15 by tasks `3.10`, `3.29`, `4.2`, `4.13`, `4.15` and `5.14`; 21.16 by tasks `1.9` and `1.20`; 21.17 by the run count stated in every property task; 21.18 by the placement of Properties 8, 24 and 42 in branches 2, 3 and 4 and of the webhook-only tests in branch 6.

- Review decisions (approved by the Developer, 2026-11-27): (1) task 1.15 removes the `scripts/seed.ts` line from `.kiro/steering/structure.md` and the words ", seed script" from `.kiro/steering/tech.md`; accepted. (2) `TransactionRepository.findByReference` (reference GSI) stays in branch 3 even if the webhook branch is cut. (3) A `POST` with a body and no `Content-Type` answers 415 `UNSUPPORTED_MEDIA_TYPE`; accepted. (4) The platform-foundation spec is closed and is not edited. The plan is approved for execution.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "1.5"] },
    { "id": 2, "tasks": ["1.6", "1.7"] },
    { "id": 3, "tasks": ["1.8", "1.10", "1.14", "1.15"] },
    { "id": 4, "tasks": ["1.9", "1.11", "1.12"] },
    { "id": 5, "tasks": ["1.13"] },
    { "id": 6, "tasks": ["1.16", "1.17", "1.18", "1.19", "1.20", "1.21", "1.22"] },
    { "id": 7, "tasks": ["1.23"] },
    { "id": 8, "tasks": ["1.24"] },
    { "id": 9, "tasks": ["2.1", "2.2", "2.5"] },
    { "id": 10, "tasks": ["2.3", "2.6"] },
    { "id": 11, "tasks": ["2.4"] },
    { "id": 12, "tasks": ["2.7"] },
    { "id": 13, "tasks": ["2.8", "2.9", "2.10", "2.11"] },
    { "id": 14, "tasks": ["2.12"] },
    { "id": 15, "tasks": ["2.13"] },
    { "id": 16, "tasks": ["3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.12"] },
    { "id": 17, "tasks": ["3.7", "3.8", "3.13", "3.14"] },
    { "id": 18, "tasks": ["3.9"] },
    { "id": 19, "tasks": ["3.10"] },
    { "id": 20, "tasks": ["3.11"] },
    { "id": 21, "tasks": ["3.15", "3.16", "3.17", "3.18", "3.19", "3.20", "3.21", "3.22", "3.23", "3.24", "3.25", "3.26", "3.27", "3.28", "3.29"] },
    { "id": 22, "tasks": ["3.30"] },
    { "id": 23, "tasks": ["3.31"] },
    { "id": 24, "tasks": ["4.1", "4.4"] },
    { "id": 25, "tasks": ["4.2"] },
    { "id": 26, "tasks": ["4.3"] },
    { "id": 27, "tasks": ["4.5", "4.6", "4.7", "4.8", "4.9", "4.10", "4.11", "4.12", "4.13", "4.14", "4.15", "4.16", "4.17", "4.18"] },
    { "id": 28, "tasks": ["4.19"] },
    { "id": 29, "tasks": ["4.20"] },
    { "id": 30, "tasks": ["5.1", "5.4", "5.7"] },
    { "id": 31, "tasks": ["5.2", "5.3", "5.6", "5.8", "5.11", "5.12", "5.13"] },
    { "id": 32, "tasks": ["5.5", "5.14"] },
    { "id": 33, "tasks": ["5.9"] },
    { "id": 34, "tasks": ["5.10"] },
    { "id": 35, "tasks": ["5.15"] },
    { "id": 36, "tasks": ["5.16"] },
    { "id": 37, "tasks": ["6.1"] },
    { "id": 38, "tasks": ["6.2", "6.3"] },
    { "id": 39, "tasks": ["6.4"] },
    { "id": 40, "tasks": ["6.5", "6.6", "6.7"] },
    { "id": 41, "tasks": ["6.8"] },
    { "id": 42, "tasks": ["6.9"] },
    { "id": 43, "tasks": ["7.1"] },
    { "id": 44, "tasks": ["7.2"] },
    { "id": 45, "tasks": ["7.3"] }
  ]
}
```
