# Requirements Document

## Introduction

This spec covers the business API of the card checkout store under `/api/v1`: the product catalog (HU-01, API side), the supporting resources (fees, customers, acceptance tokens, deliveries), the transaction lifecycle (HU-09 create, HU-10 charge, HU-11 sync, HU-12 finalize) and the payment event webhook (HU-13). It also covers the cross-cutting API behavior these endpoints need (error catalog, rate limit by client IP, idempotency, OpenAPI document and its public docs site) and the infrastructure and pipeline changes that depend on them.

The platform foundation (monorepo, CI, Terraform base, `GET /api/v1/health`, origin guard, request id, JSON logger, error filter skeleton) already exists and is not redone. This spec changes parts of it: the Lambda timeout, the `/api/*` origin request policy, the SPA rewrite function, the web sync step of `deploy.yml` and the dependency-cruiser configuration.

Decisions fixed for this spec (do not reopen):

- **Unreachable provider on create.** If the payment provider cannot be reached after the one retry (timeout or 5xx), or answers the retry with a 4xx after a first attempt that ended in timeout or 5xx, `POST /transactions` answers 201 with status PENDING and stores the transaction without an external id. The create request never reconciles inline. `GET /transactions/:id` reconciles later by `reference` with a read-only lookup at the provider and never creates a second charge. If the provider has no record of the reference about 60 s after creation, the transaction becomes ERROR with reason `PROVIDER_UNREACHABLE`. A 502 `PAYMENT_PROVIDER_ERROR` on this endpoint is reserved for a provider 4xx on the first creation attempt, which also marks the transaction ERROR and cancels the delivery.
- **Provider calls from the status endpoint.** The calls made from `GET /transactions/:id` (status by external id and lookup by reference) use a single attempt with a 3 s timeout and no retry, because client polling is the retry. Creating a transaction and fetching acceptance tokens keep a 10 s timeout and one retry.
- **Amount check before finalizing.** Before a provider status is finalized (create, sync or webhook), the provider amount, currency and reference must equal the stored transaction. A mismatch finalizes the transaction as ERROR with reason `AMOUNT_MISMATCH` and writes an alert log entry.
- **Client IP.** The rate limit keys on the `CloudFront-Viewer-Address` header, split at the last `:` so IPv6 works. The `/api/*` behavior uses one custom origin request policy that whitelists the viewer address header and the headers the API reads, and never forwards `Host`. A client-sent `X-Forwarded-For` is never used. `GET /api/v1/health` is excluded from the rate limit.
- **Catalog seed.** The four catalog products are seeded by Terraform (`aws_dynamodb_table_item` resources in `infra/`), so products are visible after the first deploy of the catalog-foundation branch with no manual step.
- **Branches.** The work ships in these branches, one pull request each, in this order: `feat/HU-01-catalog-foundation` (catalog, fees, error pipeline, domain and ports, dependencies, Terraform seed), `feat/HU-09-customers-acceptance` (customers, provider adapter, acceptance tokens, reference-lookup sandbox check), `feat/HU-09-transactions` (create, idempotency, charge, finalization core with the Amount_Check), `feat/HU-11-sync-deliveries` (status sync, reconciliation, deliveries, finalization and Amount_Check properties), `feat/HU-19-docs-rate-limit` (OpenAPI, docs site, rate limit, origin request policy), `feat/HU-13-payment-webhook` (optional, after docs and rate limit) and `docs/payments-api-evidence` (deployed evidence).
- **Concurrent Idempotency-Key.** A second request with the same key while the first is still processing answers 409 `IDEMPOTENCY_KEY_IN_PROGRESS`. The key is locked with a conditional put in state IN_PROGRESS, and the response is stored when processing finishes.
- **Webhook priority.** The webhook (HU-13, Requirement 12) is the last optional branch of this spec: it comes after docs and rate limit and before the evidence branch. Label: **cut first if late**. Polling (HU-11) is the primary path for final statuses (decision D8). The webhook requirement keeps only webhook-specific criteria. Rejection of unknown properties, idempotency and ordering for customers and transactions, create-and-sync status handling and the no-throw rule for Use_Cases belong to the non-webhook requirements and branches.
- **API error messages** are in English and fixed per code. The web app translates by `code` into Spanish (decision D12).
- **Unknown properties are rejected.** The API reads no client-sent amount. A body that contains an amount property is rejected with 400 `VALIDATION_ERROR` by the `whitelist` + `forbidNonWhitelisted` validation, which refines the wording "client-sent amounts are ignored" of the previous contract.

The words "payment provider" and the generic term `payment` are used everywhere. The provider's company name and documentation links do not appear in this spec or in anything it produces.

## Glossary

- **API**: The NestJS backend in `api/`, served under the global prefix `/api/v1`.
- **Provider**: The external payment provider, reached in Sandbox only through the Payment_Gateway_Adapter.
- **Payment_Gateway_Adapter**: The infrastructure adapter in `api/src/infrastructure/payment` that implements the `PaymentGateway` port and talks to the Provider.
- **Provider_Call_Policy**: The policy for every request the API sends to the Provider, in one of two profiles.
- **Standard_Profile**: The Provider_Call_Policy profile of the transaction creation request and the acceptance tokens request: timeout of 10 s per attempt, one retry after a backoff of 500 ms, retry only on timeout or HTTP 5xx, no retry on HTTP 4xx.
- **Single_Attempt_Profile**: The Provider_Call_Policy profile of the requests made from `GET /api/v1/transactions/:id` (status by External_Id and lookup by Reference): one attempt, timeout of 3 s, no retry. Client polling is the retry.
- **Domain_Layer**: The code in `api/src/domain`.
- **Application_Layer**: The code in `api/src/application`, made of ports and use cases.
- **Use_Case**: An application class that returns a neverthrow `Result` or `ResultAsync` and does not throw business errors.
- **Port**: An interface in `api/src/application/ports`.
- **Result_To_Http_Mapper**: The component in `api/src/infrastructure/http` that translates a Use_Case error into an HTTP status and an Error_Envelope.
- **Product**: A seeded catalog item with `id`, `sku`, `name`, `description`, `imageUrl`, `priceInCents`, `currency` and `stock`.
- **Customer**: A buyer record unique by normalized email, with `id`, `email`, `fullName`, `phone`, `documentType` and `documentNumber`.
- **Transaction**: A purchase record with status PENDING, APPROVED, DECLINED, VOIDED or ERROR, a `reference`, an optional `externalId` and a snapshot of amounts.
- **Final_Status**: One of APPROVED, DECLINED, VOIDED or ERROR.
- **Delivery**: A shipment record with status PENDING, ASSIGNED, BACKORDER or CANCELLED.
- **Reference**: The unique Transaction reference with the format `ORD-<ULID>`.
- **External_Id**: The id the Provider assigns to a Transaction.
- **Amounts**: The integer-cent values `subtotalInCents`, `baseFeeInCents`, `deliveryFeeInCents` and `totalInCents` in currency COP.
- **Integrity_Signature**: The hexadecimal SHA-256 of the concatenation `reference + amountInCents + currency + integritySecret`.
- **Event_Checksum**: The hexadecimal SHA-256 of the values of `signature.properties` (in the listed order) taken from the event data, followed by the event `timestamp` and the events secret.
- **Finalization**: The single DynamoDB `TransactWriteItems` operation that moves a PENDING Transaction to a Final_Status, updates its Delivery and, for APPROVED, decrements Product stock.
- **Reconciliation**: A read-only lookup at the Provider by Reference, sent under the Single_Attempt_Profile, that links an External_Id or establishes that the Provider has no record.
- **Amount_Check**: The comparison of the Provider-reported `amount_in_cents`, `currency` and `reference` with the `totalInCents`, `currency` and Reference stored in the Transaction.
- **Reconciliation_Window**: 60 s after Transaction creation.
- **Idempotency_Key**: The value of the `Idempotency-Key` request header of `POST /transactions`.
- **Idempotency_Record**: The item in the idempotency table with `key`, `requestHash`, state (IN_PROGRESS or COMPLETED), optional `transactionId`, stored response, `createdAt` and `expiresAt`.
- **Request_Hash**: The hexadecimal SHA-256 of the canonical JSON form (object keys sorted recursively) of the request body.
- **Error_Envelope**: The JSON error body `{ "statusCode", "code", "message", "details" }`.
- **Error_Catalog**: The table of error codes, HTTP statuses and fixed messages kept in `.kiro/steering/api-contract.md`.
- **Client_IP**: The client address used by the Rate_Limiter.
- **Rate_Limiter**: The `@nestjs/throttler` component that limits requests per Client_IP.
- **Distribution**: The CloudFront distribution that serves the web app and the API.
- **Lambda_Function**: The AWS Lambda that runs the API behind a Function URL.
- **Products_Table**: The DynamoDB table named by `DYNAMODB_TABLE_PRODUCTS`.
- **OpenAPI_Document**: The generated file `docs/openapi.json`.
- **Docs_Site**: The static site made of the Swagger UI assets from `swagger-ui-dist`, an index page and the OpenAPI_Document, published under `/docs/` from the web S3 bucket.
- **Docs_Headers_Policy**: The CloudFront response headers policy attached to the `/docs/*` behavior.
- **Security_Headers_Policy**: The existing CloudFront response headers policy attached to the default and `/api/*` behaviors.
- **API_Origin_Request_Policy**: The custom CloudFront origin request policy defined in `infra/cloudfront.tf` and attached to the `/api/*` behavior as its only origin request policy.
- **SPA_Rewrite_Function**: The CloudFront Function that rewrites extension-less paths to `/index.html`.
- **Deploy_Pipeline**: The GitHub Actions workflow `.github/workflows/deploy.yml`.
- **CI_Pipeline**: The GitHub Actions workflow `.github/workflows/ci.yml`.
- **Dependency_Cruiser_Config**: The file `api/.dependency-cruiser.cjs`.
- **Seed_Items**: The four `aws_dynamodb_table_item` Terraform resources in `infra/` that create the seeded Products in the Products_Table.
- **Deploy_Role**: The IAM role that the Deploy_Pipeline assumes through GitHub OIDC, defined in `infra/bootstrap`.
- **Developer**: The human who commits, pushes and applies bootstrap changes with personal AWS credentials.

## Requirements

### Requirement 1: Product catalog endpoints (HU-01, API side)

**User Story:** As a customer, I want the API to list the products with their price and available stock, so that the web app can show what I can buy.

**Stories:** HU-01 (consumed by HU-02 and HU-15)

#### Acceptance Criteria

1. WHEN a client sends `GET /api/v1/products`, THE API SHALL respond 200 with a JSON array that holds every Product of the Products_Table.
2. THE API SHALL order the array of `GET /api/v1/products` by `name` ascending.
3. THE API SHALL return each Product with exactly the fields `id`, `sku`, `name`, `description`, `imageUrl`, `priceInCents`, `currency` and `stock`.
4. WHILE a Product has `stock` equal to 0, THE API SHALL include the Product in the list with `stock` 0.
5. WHEN a client sends `GET /api/v1/products/:id` with the id of an existing Product, THE API SHALL respond 200 with that Product in the same field set.
6. IF the id in `GET /api/v1/products/:id` matches no Product, including an id with an invalid format, THEN THE API SHALL respond 404 with code `PRODUCT_NOT_FOUND`.
7. WHEN THE API reads Products, THE API SHALL use strongly consistent reads, so that a stock decrement committed by Finalization is visible in the next response.

### Requirement 2: Fees endpoint (supports HU-07 and HU-09)

**User Story:** As a customer, I want the API to publish the current base fee and delivery fee, so that the web app can show the same values the backend charges.

**Stories:** HU-09 (supporting endpoint, consumed by HU-07)

#### Acceptance Criteria

1. WHEN a client sends `GET /api/v1/fees`, THE API SHALL respond 200 with `currency` "COP", `baseFeeInCents` and `deliveryFeeInCents`.
2. THE API SHALL take `baseFeeInCents` from `BASE_FEE_IN_CENTS` and `deliveryFeeInCents` from `DELIVERY_FEE_IN_CENTS`, with defaults 300000 and 800000.

### Requirement 3: Customer upsert and lookup (supports HU-05 and HU-09)

**User Story:** As a customer, I want my buyer data stored once by email, so that I can reuse it across purchase attempts.

**Stories:** HU-09 (supporting endpoint, consumed by HU-05)

#### Acceptance Criteria

1. WHEN a client sends `POST /api/v1/customers` with a valid body and no Customer exists for the normalized email, THE API SHALL create the Customer and respond 201 with `id`, `email`, `fullName`, `phone`, `documentType`, `documentNumber`, `createdAt` and `updatedAt`.
2. WHEN a client sends `POST /api/v1/customers` with a valid body and a Customer exists for the normalized email, THE API SHALL update `fullName`, `phone`, `documentType` and `documentNumber`, keep `id` and `createdAt`, and respond 200 with the same field set.
3. THE API SHALL normalize an email by trimming whitespace and converting the text to lower case before lookup and storage.
4. IF `fullName` is shorter than 3 or longer than 80 characters, THEN THE API SHALL respond 400 with code `VALIDATION_ERROR` and a `details` entry that names the field and the violated rule.
5. IF `email` is not a valid email address or is longer than 120 characters, THEN THE API SHALL respond 400 with code `VALIDATION_ERROR` and a `details` entry that names the field and the violated rule.
6. IF `phone` is not made of exactly 10 digits that start with 3, THEN THE API SHALL respond 400 with code `VALIDATION_ERROR` and a `details` entry that names the field and the violated rule.
7. IF `documentType` is not one of CC, CE, NIT or PP, THEN THE API SHALL respond 400 with code `VALIDATION_ERROR` and a `details` entry that names the field and the violated rule.
8. IF `documentNumber` does not match the rule of its `documentType` (CC and CE: 6 to 10 digits; NIT: 9 to 10 digits; PP: 6 to 12 alphanumeric characters), THEN THE API SHALL respond 400 with code `VALIDATION_ERROR` and a `details` entry that names the field and the violated rule.
9. WHEN a client sends `GET /api/v1/customers/:id` with the id of an existing Customer, THE API SHALL respond 200 with the Customer.
10. IF the id in `GET /api/v1/customers/:id` matches no Customer, THEN THE API SHALL respond 404 with code `CUSTOMER_NOT_FOUND`.

### Requirement 4: Acceptance tokens (supports HU-07 and HU-10)

**User Story:** As a customer, I want to see and accept the Provider terms before paying, so that the payment is accepted by the Provider.

**Stories:** HU-10 (supporting endpoint, consumed by HU-07)

#### Acceptance Criteria

1. WHEN a client sends `GET /api/v1/acceptance-tokens`, THE API SHALL request the merchant data from the Provider with the public key under the Standard_Profile and respond 200 with `acceptanceToken { token, permalink }` and `acceptPersonalAuth { token, permalink }`.
2. IF the Provider answers with HTTP 4xx, or still fails with timeout or HTTP 5xx after the retry, THEN THE API SHALL respond 502 with code `PAYMENT_PROVIDER_ERROR`.
3. WHEN THE API sends a request to the Provider, THE Payment_Gateway_Adapter SHALL apply the Standard_Profile to the acceptance tokens request and to the transaction creation request, and the Single_Attempt_Profile to the status request and to the Reconciliation request.
4. WHEN the `feat/HU-09-customers-acceptance` branch is ready to merge, THE Developer SHALL verify against the Provider Sandbox that the lookup by Reference returns the Transaction for a known Reference and a no-record answer for an unknown Reference, and SHALL record the observed result in `.kiro/steering/payment-gateway.md` before the `feat/HU-09-transactions` branch starts.

### Requirement 5: Create the transaction in PENDING (HU-09)

**User Story:** As the system, I want to record the transaction and its delivery before charging, so that every attempt is traceable even if a later step fails.

**Stories:** HU-09

#### Acceptance Criteria

1. THE API SHALL accept in `POST /api/v1/transactions` the properties `productId`, `quantity`, `customerId`, `delivery { recipientName, phone, addressLine1, addressLine2?, city, department, postalCode? }`, `payment { cardToken, installments, brand, lastFour }`, `acceptanceToken` and `acceptPersonalAuth`.
2. IF `quantity` is not an integer from 1 to 5, THEN THE API SHALL respond 400 with code `VALIDATION_ERROR` and a `details` entry that names `quantity`.
3. IF `payment.installments` is not an integer from 1 to 36, or `payment.brand` is not VISA or MASTERCARD, or `payment.lastFour` is not exactly 4 digits, THEN THE API SHALL respond 400 with code `VALIDATION_ERROR` and a `details` entry per violated field.
4. IF a `delivery` field violates its rule (`recipientName` 3 to 80 characters; `phone` 10 digits that start with 3; `addressLine1` 5 to 120 characters; `addressLine2` at most 60 characters; `city` 2 to 60 characters; `department` one of the 32 Colombian departments or Bogotá D.C.; `postalCode` 6 digits), THEN THE API SHALL respond 400 with code `VALIDATION_ERROR` and a `details` entry per violated field.
5. IF the body is not valid JSON, lacks a required property, or contains a property that the request DTO does not declare, including any amount property, THEN THE API SHALL respond 400 with code `VALIDATION_ERROR`.
6. IF `productId` matches no Product, THEN THE API SHALL respond 404 with code `PRODUCT_NOT_FOUND`.
7. IF `customerId` matches no Customer, THEN THE API SHALL respond 404 with code `CUSTOMER_NOT_FOUND`.
8. IF the Product `stock` is lower than `quantity`, THEN THE API SHALL respond 409 with code `INSUFFICIENT_STOCK` and a message that states the available units.
9. WHEN the request is valid, the Product and the Customer exist and `stock` is at least `quantity`, THE API SHALL compute `subtotalInCents` as the Product `priceInCents` multiplied by `quantity`, `baseFeeInCents` and `deliveryFeeInCents` from the configured fees, and `totalInCents` as the sum of the three.
10. THE Domain_Layer SHALL verify that `totalInCents` equals `subtotalInCents + baseFeeInCents + deliveryFeeInCents` and that `subtotalInCents` equals `unitPriceInCents × quantity`, with all values as integers.
11. WHEN the Amounts are computed, THE API SHALL persist a Delivery in status PENDING and a Transaction in status PENDING with a new Reference, before any request to the Provider.
12. THE API SHALL persist in the Transaction the snapshot `unitPriceInCents`, the Amounts, `currency`, `installments`, `cardBrand`, `cardLastFour`, `productId`, `quantity`, `customerId` and `deliveryId`.
13. THE API SHALL keep the card token in memory for the Provider request only, and SHALL store no card number, CVC, expiry date or card token in DynamoDB.
14. WHEN the Transaction is created, THE API SHALL respond 201 with exactly `id`, `reference`, `status`, `amounts { currency, subtotalInCents, baseFeeInCents, deliveryFeeInCents, totalInCents }`, `deliveryId`, `card { brand, lastFour }` and `createdAt`.
15. WHILE a Transaction is PENDING, THE API SHALL keep the Product `stock` unchanged.

### Requirement 6: Idempotent transaction creation (HU-09)

**User Story:** As a customer, I want a repeated or double-clicked payment request to produce one transaction, so that I am not charged twice.

**Stories:** HU-09 (API side of the idempotency scenario of HU-08)

#### Acceptance Criteria

1. IF `POST /api/v1/transactions` carries no `Idempotency-Key` header or an empty one, THEN THE API SHALL respond 400 with code `MISSING_IDEMPOTENCY_KEY`.
2. IF the Idempotency_Key is not 8 to 128 characters from the set letters, digits, `.`, `_` and `-`, THEN THE API SHALL respond 400 with code `VALIDATION_ERROR`.
3. WHEN a request carries an Idempotency_Key without an Idempotency_Record and the request body is valid, THE API SHALL create the Idempotency_Record with a conditional put that requires the key to be absent, with state IN_PROGRESS, the Request_Hash and `expiresAt` 24 h ahead, before any other write.
4. IF an Idempotency_Record exists for the key and its Request_Hash differs from the Request_Hash of the request, THEN THE API SHALL respond 422 with code `IDEMPOTENCY_KEY_REUSED`.
5. WHILE the Idempotency_Record is IN_PROGRESS and younger than the Lambda_Function timeout, WHEN a request arrives with the same key and the same Request_Hash, THE API SHALL respond 409 with code `IDEMPOTENCY_KEY_IN_PROGRESS` and send no request to the Provider.
6. WHEN the API finishes processing a request, THE API SHALL set the Idempotency_Record to COMPLETED and store the HTTP status and the body of the response.
7. WHILE the Idempotency_Record is COMPLETED, WHEN a request arrives with the same key and the same Request_Hash, THE API SHALL replay the stored response, using status 200 in place of a stored 201, and create no Transaction and send no request to the Provider.
8. WHEN THE API writes the PENDING Transaction, THE API SHALL save the Transaction id in the Idempotency_Record before the first request to the Provider.
9. WHILE the Idempotency_Record is IN_PROGRESS, older than the Lambda_Function timeout and holds a Transaction id, WHEN a request arrives with the same key and the same Request_Hash, THE API SHALL respond 200 with the current state of that Transaction in the response shape of Requirement 5 criterion 14.
10. WHILE the Idempotency_Record is IN_PROGRESS, older than the Lambda_Function timeout and holds no Transaction id, WHEN a request arrives with the same key and the same Request_Hash, THE API SHALL take over the record with a conditional update on its `createdAt` and process the request.
11. IF processing ends with a business error before the PENDING Transaction is written, THEN THE API SHALL delete the Idempotency_Record so that the same key can be used again.
12. THE API SHALL set the DynamoDB TTL attribute `expiresAt` of every Idempotency_Record to 24 h after creation.
13. THE API SHALL compute the Request_Hash from the canonical JSON form of the body, so that two bodies that differ only in key order produce the same hash.

### Requirement 7: Charge the Provider (HU-10)

**User Story:** As the system, I want to send a signed charge request to the Provider after the transaction is stored, so that the payment is processed securely.

**Stories:** HU-10

#### Acceptance Criteria

1. WHEN the PENDING Transaction is persisted, THE Payment_Gateway_Adapter SHALL send the creation request to the Provider under the Standard_Profile with the private key and the properties `amount_in_cents` (the `totalInCents`), `currency` "COP", `customer_email`, `reference`, `acceptance_token`, `accept_personal_auth`, `payment_method { type "CARD", token, installments }` and `signature`.
2. THE Payment_Gateway_Adapter SHALL compute `signature` as the Integrity_Signature of the Transaction.
3. WHEN the Provider accepts the creation request, THE API SHALL store the External_Id in the Transaction.
4. WHEN the Provider accepts the creation request with a PENDING status, THE API SHALL respond 201 with the status PENDING.
5. WHEN the Provider accepts the creation request with a Final_Status, THE API SHALL run the Amount_Check and Finalization before the response and respond 201 with the resulting status.
6. IF the Provider answers the first creation attempt with HTTP 4xx, THEN THE API SHALL set the Transaction to ERROR with the Provider message as `statusReason`, set the Delivery to CANCELLED, leave the Product `stock` unchanged and respond 502 with code `PAYMENT_PROVIDER_ERROR`.
7. IF the Provider answers the retry attempt with HTTP 4xx after the first attempt ended in timeout or HTTP 5xx, THEN THE API SHALL keep the Transaction PENDING without External_Id, keep the Delivery PENDING, run no Reconciliation and send no further request to the Provider in that request, and respond 201 with status PENDING.
8. THE API SHALL read the private key and the integrity secret from the SSM parameters named by `PAYMENT_PRIVATE_KEY_PARAM` and `PAYMENT_INTEGRITY_SECRET_PARAM`.
9. THE API SHALL exclude the private key, the integrity secret, the events secret and the card token from every log line and every HTTP response.

### Requirement 8: Provider unreachable and reconciliation (HU-10, HU-11)

**User Story:** As the system, I want a transaction to survive a Provider outage without a second charge, so that the customer gets one correct result.

**Stories:** HU-10, HU-11

#### Acceptance Criteria

1. IF the creation request still ends in timeout or HTTP 5xx after the retry, or ends in HTTP 4xx on the retry after a first attempt that ended in timeout or HTTP 5xx, THEN THE API SHALL keep the Transaction PENDING without External_Id, keep the Delivery PENDING, run no Reconciliation in `POST /api/v1/transactions` and respond 201 with status PENDING.
2. THE API SHALL send at most one creation attempt and one retry to the Provider for each Reference, and SHALL send no creation request from `GET /api/v1/transactions/:id` or from the webhook.
3. WHILE a Transaction is PENDING without External_Id, WHEN a client sends `GET /api/v1/transactions/:id`, THE API SHALL run a Reconciliation by Reference, with one attempt, a timeout of 3 s and no retry.
4. WHEN a Reconciliation finds the Reference at the Provider, THE API SHALL store the External_Id and apply the Provider status as in Requirement 9.
5. IF a Reconciliation finds no record and the Transaction is at least as old as the Reconciliation_Window, THEN THE API SHALL run Finalization to ERROR with `statusReason` `PROVIDER_UNREACHABLE`, set the Delivery to CANCELLED and leave the Product `stock` unchanged.
6. IF a Reconciliation finds no record and the Transaction is younger than the Reconciliation_Window, THEN THE API SHALL keep the Transaction PENDING and respond 200 with the stored state.
7. IF the Reconciliation request itself ends in timeout or an HTTP error that does not mean "no record" on its single attempt, THEN THE API SHALL keep the Transaction PENDING, send no second request in the same `GET`, respond 200 with the stored state and write a warning log entry.

### Requirement 9: Query and synchronize the transaction (HU-11)

**User Story:** As a customer, I want to learn the result of my payment without reloading, so that I see the final outcome as soon as the Provider decides.

**Stories:** HU-11

#### Acceptance Criteria

1. WHEN a client sends `GET /api/v1/transactions/:id` with the id of an existing Transaction, THE API SHALL respond 200 with `id`, `reference`, `status`, `statusReason` (when present), `amounts`, `deliveryId`, `card { brand, lastFour }`, `productId`, `quantity`, `installments`, `createdAt`, `updatedAt` and `finalizedAt` (when present).
2. IF the id in `GET /api/v1/transactions/:id` matches no Transaction, including an id with an invalid format, THEN THE API SHALL respond 404 with code `TRANSACTION_NOT_FOUND`.
3. WHILE a Transaction is PENDING with an External_Id and its last Provider sync is at least 1 s old, WHEN a client sends `GET /api/v1/transactions/:id`, THE API SHALL request the Transaction status from the Provider with one attempt, a timeout of 3 s and no retry, and store `lastSyncedAt`.
4. WHILE a Transaction is PENDING and its last Provider sync is less than 1 s old, WHEN a client sends `GET /api/v1/transactions/:id`, THE API SHALL respond with the stored state and send no request to the Provider.
5. WHEN the Provider reports a Final_Status, THE API SHALL run the Amount_Check and Finalization before responding.
6. WHILE a Transaction has a Final_Status, WHEN a client sends `GET /api/v1/transactions/:id`, THE API SHALL respond with the stored state and send no request to the Provider.
7. IF the status request to the Provider ends in a timeout or an error on its single attempt, THEN THE API SHALL send no second request in the same `GET`, respond 200 with the stored state and write a warning log entry.
8. IF the Provider reports a status value that is not PENDING, APPROVED, DECLINED, VOIDED or ERROR, THEN THE API SHALL keep the Transaction PENDING and write a warning log entry.
9. THE API SHALL exclude the card token, the External_Id and any card data other than brand and last four digits from the Transaction response.

### Requirement 10: Atomic finalization of stock and delivery (HU-12)

**User Story:** As the business, I want an approved payment to decrement stock and assign the delivery, and any other outcome to leave stock untouched, so that inventory stays correct.

**Stories:** HU-12

#### Acceptance Criteria

1. WHEN Finalization receives APPROVED, THE API SHALL set the Transaction to APPROVED, set the Delivery to ASSIGNED and decrement the Product `stock` by `quantity`.
2. WHEN Finalization receives DECLINED, VOIDED or ERROR, THE API SHALL set the Transaction to the same status, set the Delivery to CANCELLED, leave the Product `stock` unchanged and store the Provider message as `statusReason`.
3. THE API SHALL execute Finalization as one DynamoDB `TransactWriteItems` that updates the Transaction on the condition `status = PENDING`, updates the Delivery and, for APPROVED, updates the Product on the condition `stock >= quantity`.
4. WHEN Finalization completes, THE API SHALL store `finalizedAt` in the Transaction.
5. IF Finalization receives APPROVED and the Product `stock` is lower than `quantity`, THEN THE API SHALL set the Transaction to APPROVED, set the Delivery to BACKORDER, leave the Product `stock` unchanged and write an alert log entry with the Reference and the product id.
6. IF Finalization runs for a Transaction that already has a Final_Status, THEN THE API SHALL change no item and respond with the stored state.
7. THE Domain_Layer SHALL allow a Transaction to move only from PENDING to a Final_Status and a Delivery to move only from PENDING to ASSIGNED, BACKORDER or CANCELLED.
8. THE API SHALL keep the Product `stock` at or above 0 under concurrent Finalizations.
9. WHEN a Final_Status reported by the Provider is about to be finalized from the creation response, the status sync or the webhook, THE API SHALL run the Amount_Check before Finalization.
10. IF the Amount_Check finds that the Provider-reported `amount_in_cents`, `currency` or `reference` differs from the stored `totalInCents`, currency or Reference, THEN THE API SHALL run Finalization to ERROR with `statusReason` `AMOUNT_MISMATCH`, set the Delivery to CANCELLED, leave the Product `stock` unchanged, even when the Provider reports APPROVED, and write an alert log entry with the Reference and the names of the fields that differ.
11. WHEN the Amount_Check succeeds, THE API SHALL finalize with the Provider-reported Final_Status as in criteria 1 and 2.

### Requirement 11: Delivery endpoint (HU-12)

**User Story:** As a customer, I want to query the delivery of my purchase, so that I can see where it stands.

**Stories:** HU-12

#### Acceptance Criteria

1. WHEN a client sends `GET /api/v1/deliveries/:id` with the id of an existing Delivery, THE API SHALL respond 200 with `id`, `transactionId`, `productId`, `quantity`, `recipientName`, `phone`, `addressLine1`, `addressLine2` (when present), `city`, `department`, `postalCode` (when present), `status`, `createdAt` and `updatedAt`.
2. IF the id in `GET /api/v1/deliveries/:id` matches no Delivery, including an id with an invalid format, THEN THE API SHALL respond 404 with code `DELIVERY_NOT_FOUND`.

### Requirement 12: Payment event webhook (HU-13) — cut first if late

**User Story:** As the system, I want to accept the Provider `transaction.updated` event as a backup to polling, so that a transaction closes even when no client is polling.

**Stories:** HU-13 (priority P1, last optional branch `feat/HU-13-payment-webhook`, after docs and rate limit and before the evidence branch)

#### Acceptance Criteria

1. WHEN a client sends `POST /api/v1/webhooks/payments` with an event of type `transaction.updated` and a matching checksum, THE API SHALL find the Transaction by Reference, apply the event status through the Amount_Check and Finalization of Requirement 10 and respond 200.
2. THE API SHALL compute the Event_Checksum from the event body and the events secret read from the SSM parameter named by `PAYMENT_EVENTS_SECRET_PARAM`.
3. THE API SHALL compare the computed Event_Checksum with the header `X-Event-Checksum` when the header is present, and otherwise with `signature.checksum` of the body, using a constant-time comparison.
4. IF the checksum is missing or does not match, THEN THE API SHALL respond 401 with code `INVALID_SIGNATURE` and change no state.
5. IF the Reference of a valid event matches no Transaction, THEN THE API SHALL respond 200 and write a warning log entry.
6. IF a valid event carries a status that differs from the Final_Status already stored, THEN THE API SHALL change no state, respond 200 and write a warning log entry.
7. IF a valid event has a type other than `transaction.updated`, THEN THE API SHALL respond 200 and change no state.
8. WHILE a Transaction is PENDING without External_Id, WHEN a valid event arrives for its Reference, THE API SHALL store the External_Id from the event.
9. THE API SHALL accept event properties that the webhook DTO does not declare.

### Requirement 13: Error envelope and error catalog

**User Story:** As a web developer, I want every failure to follow one format with stable codes, so that the web app can map errors without parsing messages.

**Stories:** HU-09, HU-10, HU-11, HU-12, HU-13 (cross-cutting)

#### Acceptance Criteria

1. THE API SHALL return every 4xx and 5xx response with the Error_Envelope.
2. THE API SHALL define each error code once in a single enumeration used by the Result_To_Http_Mapper, the exception filter and the OpenAPI_Document.
3. THE API SHALL map codes to HTTP statuses as follows: `VALIDATION_ERROR` 400, `MISSING_IDEMPOTENCY_KEY` 400, `INVALID_SIGNATURE` 401, `FORBIDDEN_ORIGIN` 403, `PRODUCT_NOT_FOUND` 404, `CUSTOMER_NOT_FOUND` 404, `TRANSACTION_NOT_FOUND` 404, `DELIVERY_NOT_FOUND` 404, `ROUTE_NOT_FOUND` 404, `INSUFFICIENT_STOCK` 409, `IDEMPOTENCY_KEY_IN_PROGRESS` 409, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `IDEMPOTENCY_KEY_REUSED` 422, `TOO_MANY_REQUESTS` 429, `INTERNAL_ERROR` 500 and `PAYMENT_PROVIDER_ERROR` 502.
4. IF a request matches no route, THEN THE API SHALL respond 404 with code `ROUTE_NOT_FOUND` and the fixed message "Route not found.", without the requested path in the message.
5. IF a POST request with a body carries a `Content-Type` header that is missing, whose media type is not `application/json` (compared case-insensitively), or whose `charset` parameter has a value other than `utf-8` (compared case-insensitively), THEN THE API SHALL respond 415 with code `UNSUPPORTED_MEDIA_TYPE`.
6. IF an unexpected exception occurs, THEN THE API SHALL respond 500 with code `INTERNAL_ERROR`, a fixed message and no stack trace, and write the error to the log.
7. WHEN a 400 response reports validation failures, THE API SHALL list each failure in `details` with the field name and the violated rule.
8. THE API SHALL use a fixed message per error code that does not echo request values.
9. THE Result_To_Http_Mapper SHALL translate every Use_Case error to its code and status, and THE controllers SHALL contain no business logic beyond DTO validation and that mapping.
10. THE API SHALL parse the `Content-Type` header of a POST request into a media type and its parameters before comparing, and SHALL NOT compare the raw header string.
11. WHEN a POST request carries `Content-Type` `application/json` with no parameter or with the parameter `charset=utf-8`, in any letter case, THE API SHALL accept the content type and continue the request.

### Requirement 14: Request pipeline, origin guard and logging

**User Story:** As an operator, I want every request traced and protected at the origin, so that I can follow one purchase in the logs without exposing personal data.

**Stories:** HU-09, HU-10, HU-11, HU-12, HU-13 (cross-cutting, RNF-04, RNF-05)

#### Acceptance Criteria

1. THE API SHALL return the header `X-Request-Id` on every response, including 4xx and 5xx responses.
2. IF a request to any business endpoint, including the webhook, lacks a valid `X-Origin-Verify` header, THEN THE API SHALL respond 403 with code `FORBIDDEN_ORIGIN`.
3. THE API SHALL write each log entry as one JSON object that holds `requestId` and, for Transaction-related entries, the Reference.
4. THE API SHALL mask an email in log entries by keeping the first character of the local part, followed by `***` and the domain.
5. THE API SHALL mask a document number in log entries by replacing all characters except the last 3 with `*`.
6. THE API SHALL validate request bodies with `whitelist` and `forbidNonWhitelisted` enabled and transformation enabled.

### Requirement 15: Rate limit by client IP

**User Story:** As an operator, I want a request limit per client, so that one client cannot exhaust the API.

**Stories:** HU-09, HU-10, HU-11, HU-12, HU-13 (cross-cutting, RNF-04)

#### Acceptance Criteria

1. THE Rate_Limiter SHALL allow at most 60 requests per Client_IP in a window of 60 s across the routes under `/api/v1`, except `GET /api/v1/health`.
2. IF a Client_IP exceeds the limit, THEN THE API SHALL respond 429 with code `TOO_MANY_REQUESTS`.
3. THE Rate_Limiter SHALL derive Client_IP from the header `CloudFront-Viewer-Address` by removing the port, splitting the value at the last `:`.
4. WHEN the header value is an IPv6 address with a port, THE Rate_Limiter SHALL keep all characters before the last `:` as the Client_IP.
5. IF the header `CloudFront-Viewer-Address` is missing or has no `:`, THEN THE Rate_Limiter SHALL use the remote socket address as Client_IP.
6. THE API SHALL derive Client_IP only from `CloudFront-Viewer-Address` and the socket address, and SHALL leave Express `trust proxy` disabled so that a client-sent `X-Forwarded-For` has no effect on any decision.
7. THE Rate_Limiter SHALL keep its counters in the memory of each Lambda_Function execution environment.
8. THE Distribution SHALL use the API_Origin_Request_Policy as the only origin request policy of the `/api/*` behavior, with a header whitelist of exactly `CloudFront-Viewer-Address`, `Content-Type`, `Accept`, `Idempotency-Key`, `X-Event-Checksum` and `X-Request-Id`, all query strings and no cookies, so that the API receives `CloudFront-Viewer-Address`.
9. WHEN the Deploy_Pipeline smoke test runs, THE Distribution SHALL answer `GET /api/v1/health` with status 200.
10. THE API_Origin_Request_Policy SHALL NOT forward the viewer `Host` header.
11. THE `infra/` Terraform files SHALL contain no lookup of an origin request policy defined outside the repository and no variable that selects the origin request policy, and THE Deploy_Pipeline SHALL pass no variable to Terraform that selects it.
12. THE Rate_Limiter SHALL exclude `GET /api/v1/health` from counting, so that a request to that route is never answered with 429.

### Requirement 16: Seed catalog with Terraform (HU-01)

**User Story:** As a developer, I want the catalog seeded by the infrastructure code, so that the deployed environment has products to buy after the first deploy with no manual step.

**Stories:** HU-01 (branch `feat/HU-01-catalog-foundation`)

#### Acceptance Criteria

1. THE `infra/` Terraform files SHALL define the Seed_Items as 4 `aws_dynamodb_table_item` resources on the Products_Table, each with a fixed ULID `id`.
2. THE Seed_Items SHALL give one Product `stock` 0, one Product `stock` 1 and the other Products a `stock` from 2 to 20.
3. THE Seed_Items SHALL set `imageUrl` of each Product to a path that starts with `/images/` and ends with `.webp`, `currency` to "COP" and `priceInCents` to an integer.
4. THE Seed_Items SHALL declare `lifecycle { ignore_changes = [item] }`, so that a later `terraform apply` never reverts a stock decrement committed by Finalization.
5. WHEN the Deploy_Pipeline finishes the first deploy of the `feat/HU-01-catalog-foundation` branch, THE API SHALL answer `GET /api/v1/products` with the 4 seeded Products.
6. THE Deploy_Role policy in `infra/bootstrap` SHALL grant `dynamodb:PutItem`, `dynamodb:GetItem` and `dynamodb:DeleteItem` on the ARN of the Products_Table only, and SHALL grant them on no index, no other table and no wildcard resource.
7. THE `infra/bootstrap` change that grants the Deploy_Role those three actions SHALL be the same change that adds `dynamodb:Scan` to the permissions boundary of the Lambda execution role (Requirement 19.4).
8. THE catalog SHALL come only from the Seed_Items: the repository SHALL contain no file `api/scripts/seed.ts`, no `seed` script in `api/package.json` and no manual seed step in `docs/deployment.md` or `README.md`.
9. THE test suite SHALL include static tests that read the Terraform files as text and check: exactly 4 Seed_Items, unique ULID-format ids, the `stock` rule of criterion 2, the `imageUrl` and `currency` rules of criterion 3 and `ignore_changes = [item]` on every Seed_Item.
10. THE test suite SHALL include a static test that reads `infra/bootstrap` and checks that the three actions of criterion 6 apply to the Products_Table ARN only and that `dynamodb:Scan` of Requirement 19.4 applies to the same ARN only.

### Requirement 17: Hexagonal architecture and ROP

**User Story:** As a maintainer, I want business rules isolated from frameworks and failures modeled as values, so that the logic is testable and the architecture is enforced.

**Stories:** HU-09, HU-10, HU-11, HU-12, HU-13 (cross-cutting, RNF-15)

#### Acceptance Criteria

1. THE Domain_Layer SHALL hold the entities, the value objects Money, CardBrand, TransactionStatus and DeliveryStatus, the amount calculation, the status transition rules and the domain errors, with no import from NestJS, the AWS SDK or an HTTP library.
2. THE Application_Layer SHALL define the Ports `ProductRepository`, `CustomerRepository`, `TransactionRepository`, `DeliveryRepository`, `IdempotencyRepository`, `PaymentGateway`, `Clock`, `IdGenerator` and the logging Port `ApplicationLogger`.
3. THE Application_Layer SHALL provide the Use_Cases GetProducts, GetProduct, GetFees, UpsertCustomer, GetCustomer, GetAcceptanceTokens, CreateTransaction, SyncTransactionStatus, FinalizeTransaction and GetDelivery.
4. THE Use_Cases and the repository and gateway adapters SHALL report expected failures as `Err` values of neverthrow and SHALL NOT throw for business errors.
5. THE Dependency_Cruiser_Config SHALL contain a rule that reports an error when a file under `api/src/application` imports anything other than `api/src/domain`, `api/src/application` (ports and sibling Use_Cases), `neverthrow` or a Node.js built-in module.
6. WHEN `npm run depcruise` runs inside `api/` on the committed code, THE dependency-cruiser check SHALL finish with exit code 0.
7. THE infrastructure layer SHALL implement each Port in an adapter, and the Nest module SHALL wire the Use_Cases to the adapters without decorators or Nest imports inside `api/src/application`.
8. THE DynamoDB adapters SHALL use the AWS SDK v3 document client, the table names from the validated configuration, the GSI `email` of the customers table and the GSI `reference` of the transactions table.
9. IF a DynamoDB adapter fails with an unexpected error, THEN THE adapter SHALL return an `Err` that the Result_To_Http_Mapper translates to 500 with code `INTERNAL_ERROR`.
10. WHERE the webhook branch `feat/HU-13-payment-webhook` is delivered, THE Application_Layer SHALL provide the Use_Case HandlePaymentEvent and the Port `EventChecksumVerifier`, and THE rules of criteria 4 and 7 SHALL apply to them.

### Requirement 18: OpenAPI document and public docs site (supports HU-19)

**User Story:** As an evaluator, I want a public, always-current API reference, so that I can read and try the endpoints without asking.

**Stories:** HU-19 (supporting), HU-01 and HU-09 to HU-13 (documented endpoints)

#### Acceptance Criteria

1. THE API SHALL describe every endpoint of the API contract with `@nestjs/swagger` decorators, including request DTOs, response schemas, the Error_Envelope schema, the `Idempotency-Key` header and every documented status code.
2. WHEN the OpenAPI generation script runs, THE script SHALL write the OpenAPI_Document to `docs/openapi.json` without opening a network port and without AWS or Provider calls.
3. THE script SHALL write the OpenAPI_Document deterministically, so that two runs on the same commit produce identical files.
4. THE API runtime SHALL serve no Swagger UI and SHALL NOT call `SwaggerModule.setup`.
5. WHEN the docs build script runs, THE script SHALL assemble the Docs_Site from the `swagger-ui-dist` assets, an index page without inline scripts and the OpenAPI_Document.
6. THE CI_Pipeline SHALL regenerate the OpenAPI_Document and fail when the result differs from the committed `docs/openapi.json`.
7. THE Distribution SHALL serve the path `/docs/*` from the web S3 bucket through an ordered cache behavior, with no SPA rewrite.
8. THE SPA_Rewrite_Function SHALL leave every request whose path starts with `/docs/` unchanged.
9. WHEN a viewer requests `/docs` or `/docs/`, THE Distribution SHALL serve the index page of the Docs_Site.
10. THE Distribution SHALL attach the Docs_Headers_Policy to the `/docs/*` behavior, and THE Docs_Headers_Policy SHALL equal the Security_Headers_Policy in every header except the Content-Security-Policy directive `img-src`, which SHALL be `'self' data:`.
11. WHEN the Docs_Site loads in a browser through the Distribution, THE Docs_Site SHALL render the endpoint list with no Content-Security-Policy violation in the console.
12. THE Deploy_Pipeline web sync step SHALL exclude the objects under `docs/`, so that the web upload and its `--delete` never remove or overwrite them.
13. WHEN the Deploy_Pipeline runs, THE Deploy_Pipeline SHALL run a separate docs sync step that uploads the Docs_Site to the `docs/` prefix of the web S3 bucket, deletes only objects under that prefix, and sets `no-cache` on the OpenAPI_Document.
14. WHEN the Deploy_Pipeline invalidates the Distribution, THE invalidation SHALL cover the `/docs/*` paths.
15. WHEN the Deploy_Pipeline smoke test runs, THE smoke test SHALL check that `/docs/` and `/docs/openapi.json` answer 200 and that the response header `content-security-policy` of `/docs/` contains `img-src 'self' data:`.

### Requirement 19: Lambda runtime and IAM changes

**User Story:** As an operator, I want the Lambda to outlast two Provider attempts and read the catalog, so that checkout calls finish and the product list works.

**Stories:** HU-01, HU-10, HU-11 (infrastructure support)

#### Acceptance Criteria

1. THE Lambda_Function SHALL have a timeout of 25 s in `infra/lambda.tf`.
2. THE Distribution SHALL set the origin response timeout of the Lambda origin to 30 s, which is above the Lambda_Function timeout.
3. THE Lambda execution role policy SHALL grant `dynamodb:Scan` on the ARN of the products table only, and SHALL grant `dynamodb:Scan` on no index, no other table and no wildcard resource.
4. THE permissions boundary of the Lambda execution role in `infra/bootstrap` SHALL allow `dynamodb:Scan` on the ARN of the products table only, so that the effective permission exists.
5. WHEN the permissions boundary or the Deploy_Role policy changes (Requirements 16.6 and 19.4), THE documentation in `docs/deployment.md` SHALL tell the Developer to re-apply `infra/bootstrap` once, before the first deploy of the `feat/HU-01-catalog-foundation` branch.
6. THE Terraform files SHALL pass `terraform fmt -check -recursive` and `terraform validate`.
7. THE Lambda_Function environment SHALL keep the variable names of the tech rules, with no new variable name introduced by this spec.

### Requirement 20: Dependencies

**User Story:** As a developer, I want the missing packages declared and locked, so that the build and the tests run the same everywhere.

**Stories:** HU-09, HU-10, HU-11, HU-12, HU-13 (cross-cutting)

#### Acceptance Criteria

1. THE `api/package.json` SHALL declare under `dependencies` the packages `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@nestjs/throttler`, `@nestjs/swagger`, `class-validator`, `class-transformer` and `ulid`.
2. THE `api/package.json` SHALL declare under `devDependencies` the package `swagger-ui-dist` and at least one HTTP mocking library of `nock` or `msw`.
3. THE `api/package-lock.json` SHALL match `api/package.json`, so that `npm ci` finishes with exit code 0 in `api/`.
4. THE declared versions SHALL be compatible with NestJS 11 and Node.js 22.
5. WHEN `npm run build` runs inside `api/`, THE build SHALL finish with exit code 0 and the Lambda bundle SHALL keep Nest dependency injection working.

### Requirement 21: Tests and coverage

**User Story:** As a developer, I want automated tests for every rule of this spec, so that the 80% coverage gate holds and regressions are caught.

**Stories:** HU-01, HU-09, HU-10, HU-11, HU-12, HU-13 (cross-cutting, 30 rubric points)

#### Acceptance Criteria

1. WHEN `npm test -- --coverage` runs inside `api/`, THE API SHALL report at least 80 for statements, branches, functions and lines, with a working target of 90.
2. THE test suite SHALL include a case where price 12000000 cents, quantity 2, base fee 300000 and delivery fee 800000 produce `totalInCents` 25100000.
3. THE test suite SHALL include the integrity signature computed against a known vector and, WHERE the webhook branch `feat/HU-13-payment-webhook` is delivered, the Event_Checksum computed against a known vector.
4. THE test suite SHALL include: the same Idempotency_Key twice produces one Transaction and one Provider creation call; a different body with the same key produces 422; a concurrent request with the same key produces 409 `IDEMPOTENCY_KEY_IN_PROGRESS`.
5. THE test suite SHALL include: Provider timeout then 5xx produces 201 PENDING without External_Id; a later `GET` links the External_Id by Reference without a second creation call; a missing record after the Reconciliation_Window produces ERROR with `PROVIDER_UNREACHABLE`.
6. THE test suite SHALL include: Provider 4xx produces ERROR, Delivery CANCELLED, unchanged stock and 502.
7. THE test suite SHALL include: APPROVED decrements stock and assigns the Delivery; DECLINED, VOIDED and ERROR leave stock unchanged; a repeated Finalization never decrements twice; APPROVED without stock produces BACKORDER.
8. WHERE the webhook branch `feat/HU-13-payment-webhook` is delivered, THE test suite SHALL include: webhook with a wrong checksum produces 401 and no state change; unknown Reference produces 200.
9. THE test suite SHALL include: `ROUTE_NOT_FOUND`, `UNSUPPORTED_MEDIA_TYPE` and the 61st request in 60 s producing 429.
10. THE test suite SHALL include Client_IP cases for an IPv4 value, an IPv6 value with port, a missing header and a client-sent `X-Forwarded-For` that has no effect.
11. THE test suite SHALL include property-based tests with `fast-check` for the Amounts invariant, for the Request_Hash key-order independence and for the Client_IP parsing.
12. THE test suite SHALL run without real network calls, without AWS calls and without real keys, using `aws-sdk-client-mock` and the HTTP mocking library, and SHALL use fake values such as `pub_test_fake`.
13. THE Jest configuration SHALL keep excluding from coverage only `main.ts`, `lambda.ts`, wiring-only Nest modules and type-only files.
14. THE test suite SHALL include the static Terraform tests of Requirement 16 criteria 9 and 10 and a static test of Requirement 15 criteria 8, 10 and 11 that reads `infra/` and `.github/workflows/deploy.yml`.
15. THE test suite SHALL include these cases: Provider timeout then 4xx on the retry produces 201 PENDING without External_Id and without Reconciliation in `POST`; `GET /transactions/:id` sends one status or lookup attempt with a 3 s timeout and no retry; a Provider-reported amount, currency or Reference that differs from the stored Transaction finalizes to ERROR with `AMOUNT_MISMATCH` and an alert log entry; `GET /api/v1/health` is never answered with 429.
16. THE test suite SHALL include these `Content-Type` cases: `application/json`, `application/json; charset=utf-8` and `Application/JSON; Charset=UTF-8` are accepted; `text/plain`, `application/jsonx` and `application/json; charset=latin1` produce 415 `UNSUPPORTED_MEDIA_TYPE`.
17. THE property-based tests that send requests through HTTP with `supertest` SHALL run with `numRuns` 25, and THE property-based tests of pure functions SHALL run with `numRuns` 100.
18. THE property tests for the rejection of unknown properties on customers and transactions, for the create-and-sync status handling and for the no-throw rule of Use_Cases SHALL belong to the non-webhook branches, and THE `feat/HU-13-payment-webhook` branch SHALL carry only the webhook-specific tests of criterion 8 and the acceptance of undeclared event properties.

### Requirement 22: API contract documentation

**User Story:** As a web developer, I want the written contract to match the API, so that the web spec builds against accurate rules.

**Stories:** HU-09, HU-10, HU-11, HU-12, HU-13 (documentation)

#### Acceptance Criteria

1. THE file `.kiro/steering/api-contract.md` SHALL list in its error table every code of Requirement 13 criterion 3, with the HTTP status of each.
2. THE file `.kiro/steering/api-contract.md` SHALL document that `POST /api/v1/transactions` answers 201 with status PENDING when the Provider is unreachable after the retry, and also when the Provider answers the retry with HTTP 4xx after a first attempt that ended in timeout or HTTP 5xx, and that 502 `PAYMENT_PROVIDER_ERROR` on this endpoint means a Provider 4xx on the first creation attempt.
3. THE file `.kiro/steering/api-contract.md` SHALL list for `POST /api/v1/transactions` the responses 201, 200, 400, 404, 409, 415, 422, 429 and 502.
4. THE file `.kiro/steering/api-contract.md` SHALL describe the response shape of `GET /api/v1/acceptance-tokens`, `GET /api/v1/fees` and `GET /api/v1/products`.
5. THE file `.kiro/steering/api-contract.md` SHALL state that the rate limit keys on `CloudFront-Viewer-Address` and that the Docs_Site lives under `/docs/`.
6. THE file `.kiro/steering/payment-gateway.md` SHALL state in its Resilience section the 201 PENDING behavior, the reconciliation by Reference and the Reconciliation_Window of 60 s with reason `PROVIDER_UNREACHABLE`, the Standard_Profile and the Single_Attempt_Profile of the Provider_Call_Policy, and the Amount_Check with reason `AMOUNT_MISMATCH`.
7. THE file `.kiro/steering/api-contract.md` SHALL list the `statusReason` values `PROVIDER_UNREACHABLE` and `AMOUNT_MISMATCH` with their meaning, and SHALL document that a `POST` accepts `application/json` with or without `charset=utf-8` and answers 415 `UNSUPPORTED_MEDIA_TYPE` for any other media type or charset.
8. THE file `.kiro/steering/payment-gateway.md` SHALL record the Sandbox result of the lookup by Reference required by Requirement 4 criterion 4.

## Traceability

| Requirement | Story | Branch |
|---|---|---|
| 1 Product catalog endpoints | HU-01 | `feat/HU-01-catalog-foundation` |
| 2 Fees endpoint | HU-09 (supports HU-07) | `feat/HU-01-catalog-foundation` |
| 3 Customer upsert and lookup | HU-09 (supports HU-05) | `feat/HU-09-customers-acceptance` |
| 4 Acceptance tokens and reference-lookup Sandbox check | HU-10 (supports HU-07) | `feat/HU-09-customers-acceptance` |
| 5 Create the transaction in PENDING | HU-09 | `feat/HU-09-transactions` |
| 6 Idempotent transaction creation | HU-09 | `feat/HU-09-transactions` |
| 7 Charge the Provider | HU-10 | `feat/HU-09-transactions` |
| 8 Provider unreachable and reconciliation | HU-10, HU-11 | `feat/HU-09-transactions` (create), `feat/HU-11-sync-deliveries` (reconciliation) |
| 9 Query and synchronize the transaction | HU-11 | `feat/HU-11-sync-deliveries` |
| 10 Atomic finalization and Amount_Check | HU-12 | `feat/HU-09-transactions` (finalization core and Amount_Check), `feat/HU-11-sync-deliveries` (finalization and Amount_Check properties) |
| 11 Delivery endpoint | HU-12 | `feat/HU-11-sync-deliveries` |
| 12 Payment event webhook (optional, cut first if late) | HU-13 | `feat/HU-13-payment-webhook` |
| 13 Error envelope and error catalog | HU-09 to HU-13 | `feat/HU-01-catalog-foundation` |
| 14 Request pipeline, origin guard and logging | HU-09 to HU-13 | `feat/HU-01-catalog-foundation` (request id, origin guard, validation, logger), `feat/HU-09-customers-acceptance` (log masking) |
| 15 Rate limit by client IP and origin request policy | HU-09 to HU-13 | `feat/HU-19-docs-rate-limit` |
| 16 Seed catalog with Terraform | HU-01 | `feat/HU-01-catalog-foundation` |
| 17 Hexagonal architecture and ROP | HU-09 to HU-13 | `feat/HU-01-catalog-foundation` (HandlePaymentEvent in `feat/HU-13-payment-webhook`) |
| 18 OpenAPI document and public docs site | HU-19 (supports), HU-01, HU-09 to HU-13 | `feat/HU-19-docs-rate-limit` |
| 19 Lambda runtime and IAM changes | HU-01, HU-10, HU-11 | `feat/HU-01-catalog-foundation` (IAM, bootstrap), `feat/HU-09-transactions` (timeouts) |
| 20 Dependencies | HU-09 to HU-13 | `feat/HU-01-catalog-foundation` |
| 21 Tests and coverage | HU-01, HU-09 to HU-13 | every branch |
| 22 API contract documentation | HU-09 to HU-13 | `feat/HU-19-docs-rate-limit` (22.8 is recorded in `feat/HU-09-customers-acceptance`) |

The branch `docs/payments-api-evidence` holds the deployed end-to-end evidence and adds no requirement of its own.
