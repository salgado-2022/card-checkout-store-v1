# Design Document

## Overview

This design adds the business API of the card checkout store on top of the already-deployed platform foundation (NestJS skeleton, origin guard, request id, JSON logger, CI/CD, zero-cost Terraform). It covers five areas:

1. **Domain and application layers** — entities, value objects, status transitions, ports and use cases for products, fees, customers, acceptance tokens, transactions, deliveries and the payment webhook, all returning `neverthrow` `Result`/`ResultAsync`.
2. **Infrastructure adapters** — DynamoDB repositories (AWS SDK v3 document client), the `Payment_Gateway_Adapter` (signed calls to the Provider with retry), NestJS controllers/DTOs, the idempotency mechanism, the rate limiter and the OpenAPI generation script.
3. **Infrastructure (Terraform) changes** — Lambda timeout, IAM `dynamodb:Scan` grant, the `/api/*` origin request policy, the `/docs/*` cache behaviors and headers policy, and the bootstrap permissions boundary.
4. **Pipeline changes** — `deploy.yml` docs sync step, web sync exclusion, invalidation paths and an extended smoke test; `ci.yml` is unchanged (it already runs lint/typecheck/depcruise/tests/build).
5. **Documentation** — `.kiro/steering/api-contract.md`, `.kiro/steering/payment-gateway.md` and `docs/deployment.md` updated with the final contract and the operational notes this spec introduces.

Four points were left open after the requirements phase. Each is resolved below with a concrete mechanism, not just a description of the risk:

| # | Open point | Resolution (short) | Detail |
|---|---|---|---|
| a | `/docs` and `/docs/` have no S3 index for subpaths | A small, dedicated CloudFront Function rewrites exactly `/docs` and `/docs/` to `/docs/index.html`; the SPA function is extended to ignore `/docs/*` instead of being reused for this | [Resolved Open Point A](#a-docs-index-serving) |
| b | The `/api/*` behavior needs `CloudFront-Viewer-Address` for the Client_IP rate-limit key but must never forward the viewer `Host` header to the Lambda Function URL origin | One custom origin request policy — whitelisting exactly the headers the API reads plus `CloudFront-Viewer-Address`, all query strings, no cookies, never `Host` — is the only policy attached to `/api/*` | [Resolved Open Point B](#b-origin-request-policy) |
| c | The Lambda execution role needs `dynamodb:Scan` on the products table, and the Deploy_Role needs `PutItem`/`GetItem`/`DeleteItem` on it to apply the Terraform-seeded catalog — both are below the bootstrap-managed grants | Add both grants, each scoped to the products table ARN only, in the same `infra/bootstrap` change, and document the required one-time manual re-apply before this spec's code is deployed | [Resolved Open Point C](#c-bootstrap-permissions-boundary-dynamodbscan-and-the-terraform-seeded-catalog) |
| d | "Reconciliation by Reference" assumes the Provider can be queried by *our* reference, but the only documented Provider endpoint reads by *its own* `externalId` | State the assumption explicitly, isolate it behind one `PaymentGateway` port method, and define a provider-shape-independent fallback so the rest of the system never depends on the exact wire format | [Resolved Open Point D](#d-reference-lookup-assumption-for-reconciliation) |

## Architecture

```text
Browser / curl
   │ HTTPS
   ▼
CloudFront Distribution
   ├─ default behavior        → S3 Web_Bucket (OAC)         + SPA_Rewrite_Function (viewer-request)
   ├─ "/docs"  behavior (new) → S3 Web_Bucket (OAC)         + Docs_Index_Rewrite_Function (viewer-request)
   ├─ "/docs/*" behavior (new)→ S3 Web_Bucket (OAC)         + Docs_Index_Rewrite_Function (viewer-request)
   └─ "/api/*" behavior       → Lambda Function URL         + origin_request_policy (see Open Point B)
                                     │
                                     ▼
                         Lambda_Function (Node.js 22, 512 MB, 25 s timeout)
                           NestJS app (Express adapter)
                           OriginGuardMiddleware (existing) → 403 if X-Origin-Verify missing/invalid
                           RequestIdMiddleware, RequestLoggerMiddleware (existing)
                           ThrottlerGuard (new) → 429 over 60 req/60s per Client_IP
                           Controllers → DTOs (class-validator) → Use_Cases → Result_To_Http_Mapper
                                     │
                     ┌───────────────┼────────────────────┬─────────────────────┐
                     ▼               ▼                     ▼                     ▼
                   SSM            DynamoDB            Payment Provider      CloudWatch Logs
             (private key,   (5 tables: products,     (acceptance tokens,    (JSON lines,
              integrity &     customers, transactions,  create/get txn)       7-day retention)
              events secret)  deliveries, idempotency)
```

### Request flow — create a transaction (HU-09, HU-10)

```text
Client                      API (CreateTransaction use case)                 Provider        DynamoDB
  │  POST /transactions                                                                          
  │  Idempotency-Key: k ───▶ compute Request_Hash(body)                                          
  │                          idempotencyRepo.begin(k, hash) ───────────────────────────────▶ conditional PutItem
  │                          (existing record?) ── hash differs ──▶ 422 IDEMPOTENCY_KEY_REUSED
  │                          (existing record?) ── IN_PROGRESS fresh ──▶ 409 IDEMPOTENCY_KEY_IN_PROGRESS
  │                          (existing record?) ── COMPLETED ──▶ replay stored {status,body}
  │                          validate product/customer/stock ──────────────────────────────▶ GetItem ×2
  │                          compute Amounts (Money, pure domain fn)
  │                          deliveryRepo.create(PENDING) ──────────────────────────────────▶ PutItem
  │                          transactionRepo.create(PENDING, reference) ────────────────────▶ PutItem
  │                          idempotencyRepo.attachTransactionId(k, txnId) ─────────────────▶ UpdateItem
  │                          paymentGateway.create(txn) ──────────────────────▶ POST /transactions (signed, Standard_Profile: 10s + 1 retry)
  │                                                            ◀── 201 {status, id} / 4xx / timeout|5xx
  │                          ── Final_Status ──▶ Amount_Check, then FinalizeTransaction use case ─▶ TransactWriteItems
  │                          ── PENDING ──▶ store nothing extra
  │                          ── 4xx on the first attempt (no prior timeout/5xx) ──▶ ERROR, Delivery CANCELLED, 502
  │                          ── 4xx on the retry, after the first attempt timed out/5xx'd ──▶ no Reconciliation attempted
  │                                                                                            here; stays PENDING without
  │                                                                                            External_Id, 201 (GET reconciles later)
  │                          ── timeout/5xx on both attempts ──▶ stays PENDING without External_Id, 201
  │                          idempotencyRepo.complete(k, status, body) ──────────────────────▶ UpdateItem
  │  ◀── 201 {id, reference, status, amounts, deliveryId, card, createdAt}
```

### Request flow — sync / reconciliation (HU-11)

```text
Client               API (SyncTransactionStatus use case)              Provider
  │ GET /transactions/:id
  │                    load Transaction by id ─────▶ GetItem
  │                    ── Final_Status ──▶ respond stored state, no Provider call
  │                    ── PENDING, has External_Id, lastSyncedAt >= 1s old ──▶ GET /transactions/{externalId}
  │                        │                                                   (Single_Attempt_Profile: 3s, no retry)
  │                        ── Final_Status ──▶ Amount_Check, then FinalizeTransaction, respond resulting state
  │                        ── still PENDING / error ──▶ respond stored state (+ warn log on error)
  │                    ── PENDING, no External_Id ──▶ Reconciliation (Open Point D) by reference
  │                        │                            (Single_Attempt_Profile: 3s, no retry — this GET is itself the retry)
  │                        ── found ──▶ store External_Id, apply status like above
  │                        ── not found, age >= 60s ──▶ FinalizeTransaction(ERROR, PROVIDER_UNREACHABLE)
  │                        ── not found, age < 60s ──▶ respond stored PENDING state
  │                        ── lookup itself errors ──▶ respond stored PENDING state, warn log
  │ ◀── 200 {id, reference, status, statusReason?, amounts, deliveryId, card, productId, quantity,
  │          installments, createdAt, updatedAt, finalizedAt?}
```

### Request flow — webhook (HU-13, last optional branch, after docs and rate limit and before the evidence branch)

```text
Provider                     API (HandlePaymentEvent use case)
  │ POST /webhooks/payments
  │ X-Origin-Verify, X-Event-Checksum?
  │                            compute Event_Checksum(body, eventsSecret)
  │                            compare to header (if present) else body.signature.checksum, constant-time
  │                            ── mismatch/missing ──▶ 401 INVALID_SIGNATURE, no state change
  │                            ── type != "transaction.updated" ──▶ 200, no state change
  │                            find Transaction by reference ─────▶ Query (GSI reference)
  │                            ── not found ──▶ 200 + warn log
  │                            ── found, already final, event status differs ──▶ 200 + warn log, no change
  │                            ── found, PENDING without External_Id ──▶ store External_Id from event
  │                            ── found, still PENDING ──▶ Amount_Check, then FinalizeTransaction(event status)
  │ ◀── 200 (always, once the checksum is valid)
```

## Resolved Open Points

### A. `/docs` index serving

**Problem.** `default_root_object = "index.html"` only applies to the distribution root `/`. S3 has no concept of a per-prefix index, so a request for `/docs` (no trailing slash) or `/docs/` has no object to return unless something rewrites the URI to `/docs/index.html`. The existing `SPA_Rewrite_Function` cannot be reused as-is: it rewrites *every* extension-less path to `/index.html` (the SPA's own index, a different object), and it is attached only to the default behavior, which `/docs` (no trailing slash) would actually hit because the `/docs/*` path pattern does not match the exact string `/docs`.

**Decision.** Two small, independent pieces, both already expressible in the existing Terraform/testing style:

1. **Extend `SPA_Rewrite_Function`** with an explicit guard so it is provably inert for every `/docs/`-prefixed path, mirroring the existing `/api/` guard (Requirement 18.8). This matters even though `/docs` is also covered by a dedicated behavior below, because it is a property of the function's code, not of routing, and the existing `api/test/infra/spa-rewrite.spec.ts` oracle is extended the same way it already tests `/api/`:

```js
// infra/cloudfront_function.tf — spa_rewrite, inside SPA_REWRITE_START/END markers
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf('/api/') === 0 || uri.indexOf('/docs/') === 0) {
    return request;
  }
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') !== -1) {
    return request;
  }
  request.uri = '/index.html';
  return request;
}
```

2. **Add a second, dedicated CloudFront Function**, `docs_index_rewrite`, that only rewrites the two literal strings `/docs` and `/docs/` to `/docs/index.html` and leaves every other path (including every real `/docs/*` asset such as `/docs/openapi.json`) untouched:

```hcl
# infra/cloudfront_function.tf (new resource)
resource "aws_cloudfront_function" "docs_index_rewrite" {
  name    = "${var.project_name}-docs-index-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrites /docs and /docs/ to /docs/index.html; every other /docs/* path is untouched"
  publish = true
  code    = <<-EOT
    // DOCS_INDEX_REWRITE_START
    function handler(event) {
      var request = event.request;
      if (request.uri === '/docs' || request.uri === '/docs/') {
        request.uri = '/docs/index.html';
      }
      return request;
    }
    // DOCS_INDEX_REWRITE_END
  EOT
}
```

3. **Two ordered cache behaviors**, both targeting the existing S3 origin with the new `Docs_Headers_Policy` (Requirement 18.10) and the `docs_index_rewrite` function — one for the exact path `/docs` (which `/docs/*` does not match) and one for `/docs/*`:

```hcl
# infra/cloudfront.tf (two new ordered_cache_behavior blocks, added before the /api/* one)
ordered_cache_behavior {
  path_pattern               = "/docs"
  target_origin_id           = local.s3_origin_id
  viewer_protocol_policy     = "redirect-to-https"
  allowed_methods            = ["GET", "HEAD", "OPTIONS"]
  cached_methods              = ["GET", "HEAD"]
  compress                   = true
  cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
  response_headers_policy_id = aws_cloudfront_response_headers_policy.docs.id
  function_association {
    event_type   = "viewer-request"
    function_arn = aws_cloudfront_function.docs_index_rewrite.arn
  }
}
ordered_cache_behavior {
  path_pattern               = "/docs/*"
  target_origin_id           = local.s3_origin_id
  viewer_protocol_policy     = "redirect-to-https"
  allowed_methods            = ["GET", "HEAD", "OPTIONS"]
  cached_methods              = ["GET", "HEAD"]
  compress                   = true
  cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
  response_headers_policy_id = aws_cloudfront_response_headers_policy.docs.id
  function_association {
    event_type   = "viewer-request"
    function_arn = aws_cloudfront_function.docs_index_rewrite.arn
  }
}
```

This satisfies 18.7 (served from S3, "no SPA rewrite" — a *different* function runs here, never `spa_rewrite`), 18.9 (`/docs` and `/docs/` both resolve to the index) and 18.10 (both behaviors use `Docs_Headers_Policy`). `aws_cloudfront_response_headers_policy.docs` is the Security_Headers_Policy copied with only `img-src` changed to `'self' data:` (Requirement 18.10), defined in `infra/cloudfront_headers.tf`.

### B. Origin request policy

**Problem.** The `/api/*` behavior must forward `CloudFront-Viewer-Address` (the Client_IP source for the Rate_Limiter, Requirement 15.3) and the small set of headers the API reads, while never forwarding the viewer's own `Host` header: a Lambda Function URL origin frequently answers 403 when it receives the *distribution's* `Host` instead of its own `*.lambda-url.<region>.on.aws` host. A custom policy that whitelists `CloudFront-Viewer-Address` and the API headers by name, and lists no `Host`, gives both properties in one resource.

**Decision.** One custom `aws_cloudfront_origin_request_policy` — the `API_Origin_Request_Policy` of the Glossary — is the only origin request policy of the `/api/*` behavior:

```hcl
# infra/cloudfront.tf
resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "${var.project_name}-api"
  comment = "Only origin request policy for /api/*: forwards the headers the API reads and all query strings, no cookies, never Host"
  cookies_config {
    cookie_behavior = "none"
  }
  query_strings_config {
    query_string_behavior = "all"
  }
  headers_config {
    header_behavior = "whitelist"
    headers {
      items = [
        "CloudFront-Viewer-Address",
        "Content-Type",
        "Accept",
        "Idempotency-Key",
        "X-Event-Checksum",
        "X-Request-Id",
      ]
    }
  }
}
```

The `/api/*` `ordered_cache_behavior` sets `origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id` directly (Requirement 15.8). A whitelist (never an `allExcept` or all-viewer behavior) is required because CloudFront only adds the computed `CloudFront-Viewer-Address` header when the policy's header behavior supports additions, and because listing every header by name is itself the guarantee that `Host` is never among them (Requirement 15.10). If the header whitelist above ever needs to change, it is one `terraform apply` away. A static test (Requirement 21.14) reads `infra/` and `.github/workflows/deploy.yml` as text to confirm the header list is exactly the six names above, `cookie_behavior = "none"`, `query_string_behavior = "all"`, that the `/api/*` behavior references the custom resource, and that `infra/` has no lookup of an externally defined origin request policy, no variable that selects the policy, and no such variable passed by the workflow (Requirement 15.11).

### C. Bootstrap permissions boundary, `dynamodb:Scan` and the Terraform-seeded catalog

**Problem.** Two bootstrap-managed grants are below what this spec needs. First, `GetProducts` reads the whole (tiny, 4-row) catalog with a `Scan`, the only operation that fits a table with no useful query key for "all products"; Requirement 19.3 grants `dynamodb:Scan` on the products table ARN in the Lambda role's own policy (`infra/lambda.tf`), but IAM evaluates a permissions boundary as an *intersection* — even if the role's inline policy allows `Scan`, the call is denied unless the boundary (`infra/bootstrap/main.tf`, a separate Terraform state the automated pipeline never applies) also allows it; today the boundary's `TablesAccess` statement only lists `GetItem/PutItem/UpdateItem/DeleteItem/ConditionCheckItem/Query` — no `Scan`. Second, Requirement 16 seeds the catalog with four `aws_dynamodb_table_item` resources (the Seed_Items) applied by the Deploy_Role as part of the ordinary `infra/` apply, but the Deploy_Role's `DynamoDb` statement in `infra/bootstrap/main.tf` only grants table-level actions (`CreateTable`, `DescribeTable`, ...), never the item-level `PutItem`/`GetItem`/`DeleteItem` that an `aws_dynamodb_table_item` resource's create/refresh/destroy lifecycle requires.

**Decision.** Add both missing grants in the same `infra/bootstrap` change (Requirement 16.7), each scoped exactly as Requirement 16.6/19.3/19.4 demand — the products table ARN only, no index, no other table, no wildcard — and make the one required manual step explicit and impossible to miss.

```hcl
# infra/lambda.tf — new statement, Scan is the only action and the products table is the only resource
statement {
  sid       = "ProductsTableScan"
  effect    = "Allow"
  actions   = ["dynamodb:Scan"]
  resources = [aws_dynamodb_table.products.arn]
}
```

```hcl
# infra/bootstrap/main.tf — inside aws_iam_policy.lambda_boundary, a new statement
{
  Sid      = "ProductsTableScan"
  Effect   = "Allow"
  Action   = ["dynamodb:Scan"]
  Resource = "arn:aws:dynamodb:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-products"
},
```

```hcl
# infra/bootstrap/main.tf — inside aws_iam_role_policy.deploy, a new statement alongside the
# existing table-level "DynamoDb" statement (kept separate so the item-level grant below never
# shares a statement with that one's project-wide table wildcard)
{
  Sid      = "ProductsTableSeedItems"
  Effect   = "Allow"
  Action   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:DeleteItem"]
  Resource = "arn:aws:dynamodb:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-products"
},
```

Both new statements name the literal `${var.project_name}-products` table, never the `${var.project_name}-*` wildcard the boundary and the Deploy_Role already use for their other actions — that wildcard is deliberately not reused here because Requirement 16.6/19.3/19.4 forbid a wildcard resource specifically for these five actions: `Scan` is expensive and dangerous to leave open on every current and future table, and a Deploy_Role that is not supposed to touch customer, transaction, delivery or idempotency data items must stay confined to the one table whose items Terraform itself seeds.

Terraform manages `aws_iam_policy.lambda_boundary` and `aws_iam_role_policy.deploy` as resources with stable ARNs/names; re-applying `infra/bootstrap` with both statements added takes effect the moment the apply finishes — no change to `infra/` or to either role's attachment is needed afterward. But per the repo rules, no agent and no GitHub Actions workflow ever runs `terraform apply`/`destroy` against `infra/bootstrap`; only the Developer does, from their own machine, with their own AWS CLI credentials. That apply will not happen automatically just because this spec's code is merged.

`docs/deployment.md` gets a new, prominent note (added right after the existing "Bootstrap is the only manual infrastructure step" sentence in section 2, which this spec amends to say "only *recurring* manual step"):

> **Before deploying the `feat/HU-01-catalog-foundation` branch**, re-run the bootstrap apply once, with the exact same variables used the first time:
> ```bash
> cd infra/bootstrap
> terraform apply \
>   -var github_owner=<github-owner> -var github_owner_id=<github-owner-id> \
>   -var github_repo=<github-repo> -var github_repo_id=<github-repo-id> \
>   -var state_bucket_name=<your-state-bucket-name> -var project_name=card-checkout-store
> ```
> This updates the Lambda permissions boundary to allow `dynamodb:Scan` on the products table, and the Deploy_Role to allow `PutItem`/`GetItem`/`DeleteItem` on the same table so the ordinary `infra/` apply can create the four Seed_Items. Skipping this step does not fail `terraform plan` — it fails `terraform apply` in `infra/` with an access-denied error on the `aws_dynamodb_table_item` resources below, and even if that apply somehow proceeded, every `GET /api/v1/products` call would fail at runtime with a DynamoDB access-denied error until the boundary is updated.

**The Seed_Items.** Four `aws_dynamodb_table_item` resources on `aws_dynamodb_table.products`, defined directly in `infra/`:

```hcl
# infra/dynamodb.tf — one resource per seeded product (Requirement 16.1)
resource "aws_dynamodb_table_item" "product_1" {
  table_name = aws_dynamodb_table.products.name
  hash_key   = aws_dynamodb_table.products.hash_key
  item = jsonencode({
    id           = { S = "01JC0000000000000000000001" } # fixed ULID
    sku          = { S = "SKU-001" }
    name         = { S = "..." }
    description  = { S = "..." }
    imageUrl     = { S = "/images/sku-001.webp" }         # Requirement 16.3
    priceInCents = { N = "12000000" }
    currency     = { S = "COP" }
    stock        = { N = "0" }                            # this item: stock 0 (Requirement 16.2)
  })
  lifecycle {
    ignore_changes = [item] # a later apply never reverts a Finalization-committed stock decrement (Requirement 16.4)
  }
}
# product_2 .. product_4 follow the same shape with distinct fixed ULIDs: one with stock 1, the
# other two with stock between 2 and 20 (Requirement 16.2); every imageUrl starts with "/images/"
# and ends ".webp", currency is "COP" and priceInCents is an integer (Requirement 16.3).
```

Two static tests (Requirement 16.9/16.10), both reading Terraform source as text and never applying it: one parses `infra/*.tf` and asserts exactly 4 `aws_dynamodb_table_item` resources on the Products_Table, unique ULID-format `id`s, the `stock` distribution of criterion 2, the `imageUrl`/`currency`/`priceInCents` rules of criterion 3, and `lifecycle { ignore_changes = [item] }` on every one; the other parses `infra/bootstrap/main.tf` and asserts that the `ProductsTableScan` and `ProductsTableSeedItems` statements each name the Products_Table ARN only. The repository contains no `api/scripts/seed.ts`, no `seed` script in `api/package.json`, and no manual seed step in `docs/deployment.md` or `README.md` (Requirement 16.8); after the first deploy of `feat/HU-01-catalog-foundation`, `GET /api/v1/products` already answers with the 4 seeded Products and no further action (Requirement 16.5).

### D. Reference lookup assumption for reconciliation

**Problem.** `payment-gateway.md`'s documented Provider flow only shows `GET /transactions/{externalId}` — a lookup by the id the *Provider* assigned. Requirement 8.3 needs the opposite: a transaction that is PENDING with **no** `External_Id` (the create call timed out or 5xx'd twice) must be reconciled by Reference using only *our* `reference`, which the Provider never saw confirmed. Requirement 8.2 explicitly forbids resending `POST /transactions` as the mechanism (that would risk a second charge), so Reconciliation must be a separate, read-only call.

**Decision — stated assumption.** The Provider sandbox exposes a read-only, filterable transactions listing (commonly `GET /transactions?reference=<reference>`) that returns the transaction(s) created with that merchant-supplied reference, including its Provider-assigned id and current status, or an empty/404 result when the Provider has no record of it yet. This is the only assumption in this spec that cannot be fully verified without live sandbox access, so its blast radius is deliberately kept to one method:

```ts
// api/src/application/ports/payment-gateway.ts
export type ReconciliationOutcome =
  | { kind: 'found'; externalId: string; status: ProviderStatus }
  | { kind: 'not_found' };

export interface PaymentGateway {
  create(request: PaymentCreateRequest): ResultAsync<PaymentCreateResponse, PaymentGatewayError>;
  getStatus(externalId: string): ResultAsync<ProviderStatus, PaymentGatewayError>;
  // Read-only lookup by OUR reference, used only when no External_Id is known yet (Requirement 8).
  // Never issues a creation call. See design.md "Reference lookup assumption for reconciliation".
  findByReference(reference: string): ResultAsync<ReconciliationOutcome, PaymentGatewayError>;
}
```

* `SyncTransactionStatus` (the use case behind both `GET /transactions/:id` and the age check against `Reconciliation_Window`) only ever calls `findByReference`, never anything shaped like the Provider's real query parameters. If the actual sandbox endpoint turns out to use a different parameter name, path, or returns a list instead of a single object, **only `PaymentGatewayAdapter.findByReference`'s implementation changes** — no use case, controller, or test above the adapter boundary depends on the wire shape.
* The adapter maps *any* "no match" signal from the Provider — an empty array, a 404, or a `200` with a null transaction — to `{ kind: 'not_found' }`. It never treats "not found" as an error to retry or escalate; Requirement 8.6/8.7 already define what the use case does with `not_found` (stay PENDING) versus a genuine transport error (stay PENDING, warn log) — the adapter's job is only to tell those two cases apart (HTTP/network failure on the single attempt of the Single_Attempt_Profile → `Err`; a clean "no such reference" response → `Ok({ kind: 'not_found' })`).
* This assumption is the subject of the Sandbox verification of Requirement 4.4: before the `feat/HU-09-customers-acceptance` branch merges, the Developer checks the lookup by Reference against the real Provider Sandbox and records the observed result in `.kiro/steering/payment-gateway.md`, so the engineer who later implements Requirement 7/8 in `feat/HU-09-transactions` and `feat/HU-11-sync-deliveries` starts from a confirmed checkpoint instead of discovering the wire shape mid-implementation. The port method and its fake exist from `feat/HU-01-catalog-foundation`, and the adapter implementation of `findByReference` is written in `feat/HU-11-sync-deliveries` next to `getStatus`; if the Sandbox shape differs from the assumption, only that implementation changes. The check belongs to the provider-adapter branch, not to the sync branch that later consumes `findByReference`.

## Components and Interfaces

### Domain Layer (`api/src/domain`)

No NestJS, AWS SDK or HTTP imports (Requirement 17.1). Node built-ins (`node:crypto` for ids is *not* needed here — `IdGenerator` is a port) are allowed but unused in practice; this layer is pure data and pure functions.

| Module | Contents |
|---|---|
| `money.ts` | `Money` value object: integer cents + `Currency` ("COP" only for this spec). `add`, `multiply(qty)`, equality. Throws nothing; construction validates non-negative integers and returns the value directly (callers that need validation use the application-layer DTOs, which run first). |
| `card-brand.ts` | `CardBrand = 'VISA' \| 'MASTERCARD'` plus a type guard. |
| `transaction-status.ts` | `TransactionStatus = 'PENDING' \| 'APPROVED' \| 'DECLINED' \| 'VOIDED' \| 'ERROR'`, `FinalStatus` (the subset excluding `PENDING`), and `canTransitionTransaction(from, to): boolean` — PENDING → one of the four final statuses, nothing else (Requirement 10.7). |
| `delivery-status.ts` | `DeliveryStatus = 'PENDING' \| 'ASSIGNED' \| 'BACKORDER' \| 'CANCELLED'` and `canTransitionDelivery(from, to): boolean` — PENDING → one of the other three (Requirement 10.7). |
| `amounts.ts` | `computeAmounts(unitPriceInCents, quantity, baseFeeInCents, deliveryFeeInCents): Amounts` — the single place that implements `subtotal = unitPrice × quantity`, `total = subtotal + baseFee + deliveryFee` (Requirement 5.9/5.10/21.2). All four amount fields and `unitPriceInCents` are plain `number` (validated integers), matching the "integer cents everywhere" rule (D1). |
| `amount-check.ts` | `checkAmount(reported: { amountInCents: number; currency: string; reference: string }, stored: { totalInCents: number; currency: string; reference: string }): AmountCheckResult` where `AmountCheckResult = { kind: 'match' } \| { kind: 'mismatch'; fields: Array<'amountInCents' \| 'currency' \| 'reference'> }` — a pure, three-field equality comparison, no I/O (Requirement 10.9/10.10). Called by `FinalizeTransaction` immediately before it finalizes a Provider-reported Final_Status, from all three call sites (create, sync, webhook). Created in `feat/HU-09-transactions` together with the finalization core, so that no finalization path exists without it; `feat/HU-11-sync-deliveries` adds its property test (Property 46). |
| `reference.ts` | `Reference` value object, format `ORD-<ULID>`; `isValidReference(s): boolean` used by the not-found guards. |
| `errors.ts` | Domain error union: `{ kind: 'INSUFFICIENT_STOCK'; available: number } \| { kind: 'INVALID_TRANSITION'; from; to } \| { kind: 'INVALID_AMOUNTS' }`, used as the `E` of `Result` returned by domain functions that can fail (e.g. a stock-aware decrement helper). |
| `entities.ts` | Plain interfaces: `Product`, `Customer`, `Transaction`, `Delivery` — exactly the fields enumerated in the Glossary, no methods, no framework decorators. |

### Application Layer (`api/src/application`)

Dependency-cruiser enforces: files under `api/src/application` import only `api/src/domain`, sibling `api/src/application` modules, `neverthrow`, or Node built-ins (Requirement 17.5). `node:crypto` (for the Request_Hash digest) and `node:crypto`'s `randomUUID`-style helpers are therefore usable directly inside use cases without an extra port, since they are Node built-ins, not AWS SDK/HTTP/NestJS.

#### Ports (`application/ports`)

```ts
interface ProductRepository {
  findAll(): ResultAsync<Product[], RepositoryError>;             // strongly consistent, Requirement 1.7
  findById(id: string): ResultAsync<Product | null, RepositoryError>;
  // No stock-decrement method: stock only changes inside TransactionRepository.finalize.
}
interface CustomerRepository {
  findByEmail(normalizedEmail: string): ResultAsync<Customer | null, RepositoryError>;
  findById(id: string): ResultAsync<Customer | null, RepositoryError>;
  upsert(input: UpsertCustomerInput): ResultAsync<Customer, RepositoryError>;
}
interface TransactionRepository {
  findById(id: string): ResultAsync<Transaction | null, RepositoryError>;
  findByReference(reference: string): ResultAsync<Transaction | null, RepositoryError>; // GSI "reference"
  create(input: NewTransaction): ResultAsync<Transaction, RepositoryError>;
  setExternalId(id: string, externalId: string): ResultAsync<void, RepositoryError>;
  setLastSynced(id: string, at: Date): ResultAsync<void, RepositoryError>;
  // Single TransactWriteItems; see "Finalization algorithm" below.
  finalize(input: FinalizeInput): ResultAsync<FinalizeOutcome, RepositoryError>;
}
interface DeliveryRepository {
  findById(id: string): ResultAsync<Delivery | null, RepositoryError>;
  create(input: NewDelivery): ResultAsync<Delivery, RepositoryError>;
}
interface IdempotencyRepository {
  begin(key: string, requestHash: string, now: Date): ResultAsync<BeginOutcome, RepositoryError>;
  attachTransactionId(key: string, transactionId: string): ResultAsync<void, RepositoryError>;
  complete(key: string, statusCode: number, body: unknown): ResultAsync<void, RepositoryError>;
  release(key: string): ResultAsync<void, RepositoryError>; // delete, Requirement 6.11
  takeOver(key: string, previousCreatedAt: string): ResultAsync<'taken' | 'lost_race', RepositoryError>; // Requirement 6.10
}
interface PaymentGateway {
  // Standard_Profile (10s timeout, 1 retry after 500ms backoff on timeout/5xx, never on 4xx):
  getAcceptanceTokens(): ResultAsync<AcceptanceTokens, PaymentGatewayError>;
  create(request: PaymentCreateRequest): ResultAsync<PaymentCreateResponse, PaymentGatewayError>;
  // Single_Attempt_Profile (3s timeout, exactly one attempt, no retry — client polling is the retry):
  getStatus(externalId: string): ResultAsync<ProviderStatus, PaymentGatewayError>;
  findByReference(reference: string): ResultAsync<ReconciliationOutcome, PaymentGatewayError>; // Open Point D
}
interface ApplicationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  alert(message: string, fields?: Record<string, unknown>): void; // e.g. BACKORDER
}
// Webhook branch only (`feat/HU-13-payment-webhook`): created there with its adapter and fake, so cutting the branch leaves no unused port behind.
interface EventChecksumVerifier {
  verify(event: unknown, headerChecksum: string | undefined): ResultAsync<boolean, PaymentGatewayError>; // constant-time compare, secret read from SSM; Ok(false) on missing or mismatched checksum
}
interface Clock {
  now(): Date;
}
interface IdGenerator {
  ulid(): string;
}
```

`BeginOutcome` is a discriminated union covering every branch of Requirement 6: `{ kind: 'created' } | { kind: 'hash_mismatch' } | { kind: 'in_progress_fresh' } | { kind: 'in_progress_stale'; transactionId: string | null } | { kind: 'completed'; statusCode: number; body: unknown }`. "Fresh" vs. "stale" is decided by the adapter comparing `now() - record.createdAt` against the Lambda timeout (25 s), using the injected `Clock`, not the system clock directly — this is what makes 6.9/6.10 unit-testable without real waiting.

#### Use cases (`application/use-cases`)

| Use case | Summary | Key `Err` variants |
|---|---|---|
| `GetProducts` | `ProductRepository.findAll()`, map to response DTO sorted by `name`. | `REPOSITORY_ERROR` |
| `GetProduct` | `findById`; `null` → `PRODUCT_NOT_FOUND`. | `PRODUCT_NOT_FOUND`, `REPOSITORY_ERROR` |
| `GetFees` | Pure function of `AppConfig`. | — (always `Ok`) |
| `UpsertCustomer` | Normalize email, validate already done by the DTO; `CustomerRepository.upsert`. | `REPOSITORY_ERROR` |
| `GetCustomer` | Same shape as `GetProduct`. | `CUSTOMER_NOT_FOUND`, `REPOSITORY_ERROR` |
| `GetAcceptanceTokens` | `PaymentGateway.getAcceptanceTokens()` under the Standard_Profile (implemented in the adapter, Requirement 4.3). | `PAYMENT_PROVIDER_ERROR` |
| `CreateTransaction` | Orchestrates idempotency (Requirement 6), validation gates (product/customer/stock), amount computation, PENDING persistence, the Provider create call under the Standard_Profile, and — when the Provider already returns a Final_Status — delegates to `FinalizeTransaction` before responding. A 4xx on the retry after a first attempt that timed out or 5xx'd leaves the Transaction PENDING without an External_Id and runs no Reconciliation inline (Requirement 7.7/8.1); only a later `GET` reconciles it. See sequence diagram above. | `MISSING_IDEMPOTENCY_KEY`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_IN_PROGRESS`, `PRODUCT_NOT_FOUND`, `CUSTOMER_NOT_FOUND`, `INSUFFICIENT_STOCK`, `PAYMENT_PROVIDER_ERROR`, `REPOSITORY_ERROR` |
| `SyncTransactionStatus` | Backs `GET /transactions/:id`. Branches on status/External_Id/`lastSyncedAt` age exactly as Requirement 9/8 describe; both `getStatus` and `findByReference` run under the Single_Attempt_Profile, because this `GET` itself is the retry; calls `FinalizeTransaction` when the Provider reports a Final_Status. | `TRANSACTION_NOT_FOUND`, `REPOSITORY_ERROR` (Provider errors never surface — they fall back to the stored state plus a warn log, per 8.7/9.7) |
| `FinalizeTransaction` | Runs the Amount_Check (`checkAmount`) against the Provider-reported `amount_in_cents`/`currency`/`reference` before every finalization, then orchestrates `TransactionRepository.finalize` (the single `TransactWriteItems`); a mismatch is finalized as ERROR/`AMOUNT_MISMATCH` regardless of the reported status (Requirement 10.9/10.10). Idempotent: if the use case is invoked for a transaction whose stored status is already final, it returns the stored state without issuing a write or re-running the Amount_Check (Requirement 10.6). | `REPOSITORY_ERROR` |
| `GetDelivery` | Same shape as `GetProduct`. | `DELIVERY_NOT_FOUND`, `REPOSITORY_ERROR` |
| `HandlePaymentEvent` | Checksum verification (constant-time), event-type filter, reference lookup, External_Id backfill, delegates to `FinalizeTransaction` (which runs the Amount_Check exactly as the create and sync paths do). Always resolves to `Ok` except for a checksum failure, which the controller maps to 401 — the use case itself returns a discriminated result so "unknown reference" and "stale/conflicting status" are distinguishable only for logging, not for the HTTP response (both are 200). | `INVALID_SIGNATURE`, `REPOSITORY_ERROR` |

#### Idempotency algorithm (`CreateTransaction`, Requirement 6)

```text
1.  key = header["Idempotency-Key"]; if missing/empty → Err(MISSING_IDEMPOTENCY_KEY)
2.  if key does not match /^[A-Za-z0-9._-]{8,128}$/ → Err(VALIDATION_ERROR)
3.  hash = sha256hex(canonicalJson(body))                      // Requirement 6.13, 21.11
4.  outcome = idempotencyRepo.begin(key, hash, clock.now())
5.  switch outcome.kind:
      'hash_mismatch'        → Err(IDEMPOTENCY_KEY_REUSED)                      // 6.4
      'in_progress_fresh'    → Err(IDEMPOTENCY_KEY_IN_PROGRESS)                 // 6.5
      'completed'            → Ok(replay outcome.statusCode/body, 201→200)      // 6.7
      'in_progress_stale' with transactionId  → Ok(load+return that Transaction, 200)   // 6.9
      'in_progress_stale' without transactionId →
            if idempotencyRepo.takeOver(key, ...) == 'lost_race' → retry step 4 once     // 6.10
            else → continue to step 6 as if 'created'
      'created'              → continue to step 6
6.  validate product exists, customer exists, stock >= quantity  // 5.6-5.8
      on failure → idempotencyRepo.release(key); return Err(...)                // 6.11
7.  amounts = computeAmounts(...)                                              // 5.9/5.10
8.  delivery = deliveryRepo.create(PENDING)                                     // 5.11
9.  transaction = transactionRepo.create(PENDING, reference, snapshot)         // 5.11/5.12
10. idempotencyRepo.attachTransactionId(key, transaction.id)                   // 6.8
11. result = paymentGateway.create(transaction)                                // Requirement 7
12. apply result per Requirement 7/8 (finalize, or stay PENDING, or ERROR+502)
13. idempotencyRepo.complete(key, httpStatus, responseBody)                    // 6.6
14. return Ok(httpStatus, responseBody)
```

Step 6's failure path (release then return) is the only place `release` is called — once step 8 has run, a failure must *not* release the key, because a second identical request must then see the real (possibly still-PENDING) transaction rather than starting over and double-charging.

#### Finalization algorithm (`FinalizeTransaction`, Requirement 10)

```text
1. transaction = transactionRepo.findById(id)   // or passed in directly by the caller
2. if transaction.status != PENDING → return Ok(transaction)        // 10.6, idempotent no-op
3. amountCheck = checkAmount({ amountInCents, currency, reference }, transaction)      // 10.9, run for every call
                                                                                        // site: create, sync, webhook
   if amountCheck.kind == 'mismatch':
     providerStatus := ERROR; reason := 'AMOUNT_MISMATCH'                              // 10.10 — overrides whatever
                                                                                        // the Provider reported, even APPROVED
     write an alert log entry with the Reference and amountCheck.fields
4. if providerStatus == APPROVED (only possible when the Amount_Check matched):
     attempt TransactWriteItems:
       - Update Transaction  SET status=APPROVED, finalizedAt=now   WHERE status = PENDING
       - Update Delivery     SET status=ASSIGNED                    WHERE status = PENDING
       - Update Product      SET stock = stock - quantity           WHERE stock >= :quantity
     on ConditionalCheckFailed from the Product update only:
       retry the same transaction as BACKORDER (step 5), write an alert log with reference+productId   // 10.5
     on ConditionalCheckFailed from the Transaction update:
       re-read and return Ok(stored state)   // another caller already finalized it, 10.6/10.8
5. else (DECLINED | VOIDED | ERROR | AMOUNT_MISMATCH | BACKORDER path):
     TransactWriteItems:
       - Update Transaction  SET status=<status>, statusReason=<reason>, finalizedAt=now WHERE status = PENDING
       - Update Delivery     SET status=<BACKORDER if the stock check failed, else CANCELLED> WHERE status = PENDING
6. return Ok(resulting Transaction state)
```

Step 3 is the Amount_Check (Requirement 10.9): the same function, the same place, for all three callers of `FinalizeTransaction` (the creation response, `SyncTransactionStatus`, and `HandlePaymentEvent`), so none of them can finalize a mismatched report by skipping a check that lives only in one caller. A mismatch always wins over whatever `providerStatus` was reported — including APPROVED — and routes to the declined-family branch with `statusReason = 'AMOUNT_MISMATCH'`, Delivery CANCELLED and stock untouched (Requirement 10.10); a match lets the originally reported status proceed exactly as before (Requirement 10.11).

Modeling BACKORDER as "step 4 retried as step 5 with the Transaction set to APPROVED and the Delivery set to BACKORDER" keeps the three outcomes (APPROVED+stock, APPROVED-without-stock→BACKORDER, declined-family including AMOUNT_MISMATCH) inside one `TransactWriteItems` call each — there is never a second write for the same reference, which is what keeps stock non-negative under concurrent finalizations (10.8): two concurrent APPROVED finalizations for different transactions on the same product race on the Product's conditional `stock >= :quantity`; exactly one can win per unit of remaining stock, and the loser falls into the BACKORDER branch instead of oversubscribing the count.

### Infrastructure Layer (`api/src/infrastructure`)

#### `http/controllers`

One controller per resource (`products`, `fees`, `customers`, `acceptance-tokens`, `transactions`, `deliveries`, `webhooks`), each only: build the use-case input from the validated DTO + path params, call the use case, map `Result` to the HTTP response via the shared `Result_To_Http_Mapper` (an extension of the existing `ResultExceptionFilter`, see Error Handling). No branching beyond that lives in a controller (Requirement 13.9).

`TransactionsController.create` is the one controller method with extra plumbing: it reads the `Idempotency-Key` header and passes it straight through to `CreateTransaction` — the header parsing *rule* (format, canonical hashing) stays inside the use case/application layer as designed above, not in the controller, so it is covered by the use-case-level property tests without an HTTP harness.

#### `http/dto`

`class-validator` DTOs with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` already enabled globally (Requirement 14.6, reusing the existing `ValidationPipe` registration point in `createApp`). One DTO per nested object (`DeliveryDto`, `PaymentDto` inside `CreateTransactionDto`), each annotated with `@nestjs/swagger` decorators (`@ApiProperty`) so the OpenAPI document (Requirement 18.1) is generated from the same source of truth as the runtime validation. The `transaction.updated` webhook DTO is the one exception to `forbidNonWhitelisted`: Requirement 12.9 requires it to *accept* undeclared event properties, so that specific DTO sets `forbidNonWhitelisted: false` via a per-route `ValidationPipe` override, not the global default.

#### `http/security`

- `client-ip.ts` (new, alongside the existing `timing-safe-equal.ts`): `deriveClientIp(headerValue, socketAddress): string` — implements the "split at the last `:`" rule (Requirement 15.3-15.5), used only by the throttler's custom `getTracker`, never by business logic (Requirement 15.6 keeps `X-Forwarded-For` irrelevant by construction: it is simply never read anywhere in this codebase).
- `rate-limit.module.ts` (new): wraps `@nestjs/throttler`'s `ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 60 }] }, { getTracker: (req) => deriveClientIp(req.headers['cloudfront-viewer-address'], req.socket.remoteAddress) })` and a global `APP_GUARD` of `ThrottlerGuard`. The default in-memory `ThrottlerStorageService` already satisfies "keep counters in the Lambda execution environment's memory" (Requirement 15.7) — no custom storage adapter is introduced. `HealthController.check` carries `@SkipThrottle()` (Requirement 15.1/15.12), so `GET /api/v1/health` is never counted and never answered 429, which keeps the Deploy_Pipeline smoke test (Requirement 15.9) reliable regardless of how many times it polls.

#### `http/middleware`

- `content-type-guard.middleware.ts` (new, in `api/src/infrastructure/http/middleware/` next to the existing `body-parser-error.middleware.ts` and `origin-guard.middleware.ts`, registered in `create-app.ts` before the body parser): on a `POST` whose body is non-empty, parses the `Content-Type` header into `{ mediaType, params }` (never comparing the raw header string, Requirement 13.10) and accepts the request only when `mediaType` compares case-insensitively equal to `application/json` and `params.charset`, if present, compares case-insensitively equal to `utf-8` (Requirement 13.11); a missing header, any other media type, or any other `charset` value responds 415 `UNSUPPORTED_MEDIA_TYPE` before the body reaches the JSON parser or any DTO (Requirement 13.5).

#### `persistence` (DynamoDB adapters, AWS SDK v3 `@aws-sdk/lib-dynamodb` document client)

One adapter class per port, one file per adapter (`product.repository.dynamodb.ts`, etc.), constructed with the `DynamoDBDocumentClient` and the table name from `AppConfig.tables.*`. Every adapter method that is not a documented "not found" case and throws from the SDK is caught and mapped to `Err({ kind: 'REPOSITORY_ERROR', ... })` — never rethrown — which the mapper turns into 500 `INTERNAL_ERROR` (Requirement 17.9). `ProductRepository.findAll` passes `ConsistentRead: true` on the `ScanCommand` (Requirement 1.7); `TransactionRepository.findByReference` uses `QueryCommand` against the `reference` GSI; `CustomerRepository.findByEmail` uses `QueryCommand` against the `email` GSI.

`TransactionRepository.finalize` is the only adapter method that builds a `TransactWriteItemsCommand` with three `Update` items (Transaction/Delivery/Product), each carrying the `ConditionExpression` described in the Finalization algorithm; a `TransactionCanceledException` is inspected item-by-item (`CancellationReasons`) to tell "someone already finalized this" (Transaction condition failed) apart from "stock ran out" (Product condition failed) — the two branches of step 4 above.

#### `payment` (Payment_Gateway_Adapter)

- `integrity-signature.ts`: `computeIntegritySignature(reference, amountInCents, currency, secret) => sha256hex(reference + amountInCents + currency + secret)` (Requirement 7.2).
- `event-checksum.ts`: `computeEventChecksum(signatureProperties: string[], timestamp: string, secret) => sha256hex(...)`, and `verifyEventChecksum(computed, provided) => timingSafeEqualStrings(computed, provided)` reusing the existing `timing-safe-equal.ts` helper (Requirement 12.2/12.3).
- `provider-call-policy.ts`: two named wrappers around the same `AbortController`-based attempt primitive, so each call site's profile is visible without reading a config object — `withStandardProfile(fn: () => Promise<Response>): ResultAsync<Response, PaymentGatewayError>` (timeout 10 s per attempt, exactly one retry after a 500 ms backoff, retried only when the attempt times out or returns 5xx, never on 4xx) used by `create` and `getAcceptanceTokens`; and `withSingleAttemptProfile(fn: () => Promise<Response>): ResultAsync<Response, PaymentGatewayError>` (timeout 3 s, exactly one attempt, no retry under any outcome) used by `getStatus` and `findByReference`, because the web app's 2 s polling of `GET /transactions/:id` is itself the retry (Requirement 4.3). `findByReference`'s "not found" outcome is a *successful* response under `withSingleAttemptProfile`, not a retry trigger.
- `payment-gateway.adapter.ts`: implements the port; reads `PAYMENT_PRIVATE_KEY_PARAM`/`PAYMENT_INTEGRITY_SECRET_PARAM`/`PAYMENT_EVENTS_SECRET_PARAM` through the same SSM-parameter-cache pattern already used by `origin-secret.provider.ts` (module-scope cache keyed by parameter name, loaded once per cold start). `findByReference` is implemented per Open Point D.

**Timing analysis (Lambda 25 s timeout, Requirement 19.1).** Every Provider call falls under one of two profiles, and no request combines them: `POST /transactions` makes no lookup or status call (no inline Reconciliation, Requirement 8.1), and `GET /transactions/:id` and the webhook never send a creation request (Requirement 8.2).

| Request | Provider calls | Worst case on the Provider |
|---|---|---|
| `POST /transactions` | `create`, Standard_Profile | 10 s timeout + 500 ms backoff + 10 s timeout = 20.5 s |
| `GET /acceptance-tokens` | `getAcceptanceTokens`, Standard_Profile | 20.5 s |
| `GET /transactions/:id` | one `getStatus` or one `findByReference`, Single_Attempt_Profile | 3 s |
| `POST /webhooks/payments` | none | 0 s |

The 5xx-then-4xx case ends earlier than the double timeout, so it needs no separate budget. For `POST /transactions` the remaining 4.5 s covers the idempotency `begin`, the product and customer reads, the Delivery and Transaction writes, `attachTransactionId`, `complete` and, on a cold start, the SSM reads of the private key and the integrity secret, each a single-digit-millisecond to low-hundreds-of-milliseconds DynamoDB or SSM call. That is inside the 25 s Lambda timeout, which the CloudFront origin's 30 s `origin_read_timeout` (Requirement 19.2) exceeds, so CloudFront never cuts the response short first. A Final_Status on the creation response adds one `TransactWriteItems` call but only happens when no attempt timed out, so it never stacks on top of the 20.5 s case. `GET /transactions/:id` has a hard 3 s Provider ceiling plus at most one `TransactWriteItems`, far from the budget. A slow or hanging Provider on one `GET` costs only that one poll, because the 2 s client polling interval is the retry. The stale threshold of the Idempotency_Record (25 s, Requirement 6.5) equals the Lambda timeout, so a record is treated as stale only after the invocation that owned it can no longer be running.

Nothing in this adapter ever logs or returns the private key, the three secrets, or the card token (Requirement 7.9) — every error type carries only a `reason` string (HTTP status or exception class name), exactly like the existing `OriginSecretError`/`BootstrapError` pattern.

## Data Models

DynamoDB item shapes (tables already provisioned by platform-foundation):

```text
products        pk id          { id, sku, name, description, imageUrl, priceInCents, currency, stock }
customers       pk id, GSI email
                             { id, email, fullName, phone, documentType, documentNumber, createdAt, updatedAt }
transactions    pk id, GSI reference
                             { id, reference, status, statusReason?, productId, quantity, customerId,
                               deliveryId, unitPriceInCents, subtotalInCents, baseFeeInCents,
                               deliveryFeeInCents, totalInCents, currency, installments, cardBrand,
                               cardLastFour, externalId?, lastSyncedAt?, createdAt, updatedAt, finalizedAt? }
deliveries      pk id        { id, transactionId, productId, quantity, recipientName, phone, addressLine1,
                               addressLine2?, city, department, postalCode?, status, createdAt, updatedAt }
idempotency_keys pk key      { key, requestHash, state (IN_PROGRESS|COMPLETED), transactionId?,
                               responseStatusCode?, responseBody?, createdAt, expiresAt }
```

No item in `transactions` ever stores `cardToken`, a card number, CVC or expiry (Requirement 5.13); `idempotency_keys.responseBody` stores exactly the same JSON the client receives, which already excludes those fields by construction.

## API Contract (summary — full detail in `.kiro/steering/api-contract.md`)

| Method | Path | Auth gate | Responses |
|---|---|---|---|
| GET | `/products` | origin guard | 200 |
| GET | `/products/:id` | origin guard | 200, 404 |
| GET | `/fees` | origin guard | 200 |
| GET | `/acceptance-tokens` | origin guard | 200, 502 |
| POST | `/customers` | origin guard | 201, 200, 400 |
| GET | `/customers/:id` | origin guard | 200, 404 |
| POST | `/transactions` (`Idempotency-Key` required) | origin guard | 201, 200, 400, 404, 409, 415, 422, 429, 502 |
| GET | `/transactions/:id` | origin guard | 200, 404 |
| GET | `/deliveries/:id` | origin guard | 200, 404 |
| POST | `/webhooks/payments` | origin guard + checksum | 200, 401 |

## Error Handling

The existing `ResultExceptionFilter`/`CODE_BY_STATUS` table (currently generic: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, ...) is extended with a `BUSINESS_ERROR_TO_HTTP` table that is the single enumeration Requirement 13.2 requires, consumed by three places exactly as that requirement specifies: the `Result_To_Http_Mapper` (new — translates a use case's domain/application `Err` into an `HttpException` with the right status and code before the existing filter ever runs), the exception filter itself (unchanged, still the last line of defense for anything that is already an `HttpException` or an unexpected throw), and the OpenAPI generation script (imports the same table to document every status code per endpoint).

```ts
// infrastructure/http/error-catalog.ts
export const ERROR_CATALOG = {
  VALIDATION_ERROR:              { status: 400 },
  MISSING_IDEMPOTENCY_KEY:       { status: 400 },
  INVALID_SIGNATURE:             { status: 401 },
  FORBIDDEN_ORIGIN:               { status: 403 },
  PRODUCT_NOT_FOUND:              { status: 404 },
  CUSTOMER_NOT_FOUND:             { status: 404 },
  TRANSACTION_NOT_FOUND:          { status: 404 },
  DELIVERY_NOT_FOUND:             { status: 404 },
  ROUTE_NOT_FOUND:                { status: 404 },
  INSUFFICIENT_STOCK:             { status: 409 },
  IDEMPOTENCY_KEY_IN_PROGRESS:    { status: 409 },
  PAYLOAD_TOO_LARGE:              { status: 413 },
  UNSUPPORTED_MEDIA_TYPE:         { status: 415 },
  IDEMPOTENCY_KEY_REUSED:         { status: 422 },
  TOO_MANY_REQUESTS:              { status: 429 },
  INTERNAL_ERROR:                 { status: 500 },
  PAYMENT_PROVIDER_ERROR:         { status: 502 },
} as const satisfies Record<string, { status: number }>;
```

Every message is a fixed string literal keyed by code (never built from request data — Requirement 13.8), defined next to the table. `Result_To_Http_Mapper.toHttpException(err)` is a pure function (`DomainOrApplicationError -> HttpException`) with one `switch` arm per `err.kind`, so adding a new use-case error later means adding one arm and (if new) one catalog entry — never touching a controller.

## Infrastructure (Terraform) and Pipeline Changes

- **`infra/lambda.tf`**: `timeout = 25` (was 15, Requirement 19.1); new `ProductsTableScan` IAM statement (Open Point C).
- **`infra/dynamodb.tf`**: four new `aws_dynamodb_table_item` Seed_Items on `aws_dynamodb_table.products`, each with `lifecycle { ignore_changes = [item] }` (Open Point C, Requirement 16).
- **`infra/cloudfront.tf`**: origin's `custom_origin_config.origin_read_timeout`/`origin_keepalive_timeout` — specifically `origin_read_timeout = 30` (Requirement 19.2, above the Lambda's 25 s); new `aws_cloudfront_origin_request_policy.api`, the only origin request policy the `/api/*` behavior's `origin_request_policy_id` ever references (Open Point B); two new `ordered_cache_behavior` blocks for `/docs` and `/docs/*` (Open Point A), placed before the `/api/*` block so CloudFront evaluates the more specific docs patterns first.
- **`infra/cloudfront_function.tf`**: `spa_rewrite` gains the `/docs/` guard (Open Point A); new `docs_index_rewrite` function.
- **`infra/cloudfront_headers.tf`**: new `aws_cloudfront_response_headers_policy.docs`, identical to `.security` except `img-src 'self' data:` (Requirement 18.10) — implemented by extracting the shared header list into a `locals` value both policies reference, so a future change to HSTS/frame-options/etc. cannot drift between the two.
- **`infra/bootstrap/main.tf`**: new `ProductsTableScan` statement inside `aws_iam_policy.lambda_boundary` and new `ProductsTableSeedItems` statement inside `aws_iam_role_policy.deploy` (Open Point C).
- **`.github/workflows/deploy.yml`**:
  - `deploy-web`'s `aws s3 sync` gains `--exclude "docs/*"` (Requirement 18.12).
  - A new `docs sync` step (same job or a new one depending on task breakdown) runs after the web sync: `aws s3 sync docs/site "s3://$WEB_BUCKET_NAME/docs" --delete` plus a dedicated `aws s3 cp docs/site/openapi.json ... --cache-control no-cache` (Requirement 18.13).
  - The `cloudfront create-invalidation --paths` list gains `/docs/*` alongside the existing `/*` (Requirement 18.14) — in practice `/*` already covers it, but the requirement is explicit so the invalidation call documents the intent rather than relying on the broader wildcard silently covering it.
  - `scripts/smoke-test.sh` gains two checks: `GET /docs/` (200 + the six existing headers, `content-security-policy` additionally checked for `img-src 'self' data:`) and `GET /docs/openapi.json` (200) — Requirement 18.15, 15.9.
- **`api/.dependency-cruiser.cjs`**: new rule, `application-layer-allowed-imports` — `from: '^src/application'`, forbidding anything except `^src/domain`, `^src/application`, `neverthrow`, and Node built-ins (Requirement 17.5), mirrored by the already-present domain rules.
- **`docs/deployment.md`**: the bootstrap re-apply note covering both the `Scan` and the Seed_Items grants (Open Point C), in "Verification" (§7) with a cross-reference from §2.
- **`.kiro/steering/api-contract.md`**: full endpoint table, full error table, idempotency semantics, `Reference`/reconciliation summary, the `statusReason` values `PROVIDER_UNREACHABLE` and `AMOUNT_MISMATCH`, and the `Content-Type` acceptance rule (Requirement 22.1-22.5, 22.7).
- **`.kiro/steering/payment-gateway.md`**: Resilience section gains the 201-PENDING behavior, the Reconciliation_Window and `PROVIDER_UNREACHABLE` reason, the Standard_Profile and Single_Attempt_Profile, and the Amount_Check with `AMOUNT_MISMATCH` (Requirement 22.6), plus the Open Point D assumption as a short "Reconciliation lookup" note and the Sandbox reference-lookup result recorded under Requirement 4.4/22.8.

## Testing Strategy

Following `.kiro/steering/testing.md`: domain functions get 100% coverage with plain Jest (no mocks) — `computeAmounts`, `checkAmount`, the two transition-rule functions, `Reference` validation. Use cases get fake in-memory ports (one fake per port, reused across use-case tests) exercising every `Ok`/`Err` branch, including the time-dependent idempotency branches via an injectable `Clock` fake rather than real delays. Adapters get `aws-sdk-client-mock` (DynamoDB) and `nock` or `msw` (Provider HTTP calls) — never a real network or AWS call (Requirement 21.12). HTTP-level tests use `supertest` against the Nest module with a fully faked application layer, covering DTO rejections, the error-code-to-status table, and the `Idempotency-Key` header contract. `fast-check` property tests (tagged `Feature: payments-api, Property N: ...`) implement the properties below; everything else in the table is example-based or a static/Terraform-text check, per the PBT-appropriateness guidance (IaC, one-shot wiring facts, and architectural constraints are deliberately example/static checks, not property tests).

**Property test run counts (Requirement 21.17).** A property test that drives its input through an HTTP request with `supertest` — i.e. it asserts on the response of a real Nest `INestApplication` instance, even with faked ports underneath — runs with `numRuns: 25`; the HTTP round trip and the faked I/O behind it make 100 iterations costly for no extra coverage. A property test of a pure function (a domain function, a cryptographic formula, a CloudFront Function body executed in isolation, or a use-case/adapter exercised directly against in-memory fakes without going through the Nest HTTP pipeline) keeps `numRuns: 100`. Each property below is tagged with the run count its test uses; the tag travels with the `fast-check` call, not with the property statement itself, so a future change in how a property is exercised (HTTP vs. direct) only means changing that one `numRuns` argument.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system. The properties below were derived from the acceptance-criteria prework above; properties that were duplicates or strict subsets of another (for example, every "not found" case across the four resources, or every per-field validation rule across the customer/transaction DTOs) were merged into one generalized property, noted inline.*

### Property 1: Products are listed completely, sorted, with the exact field set

For any set of seeded Products (including ones with `stock` 0), `GET /products` returns 200 with an array containing exactly those products, sorted by `name` ascending, each serialized with exactly the fields `id, sku, name, description, imageUrl, priceInCents, currency, stock`.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4** (numRuns: 25, HTTP)

### Property 2: Fetching an existing resource returns it with its documented shape

For any existing Product, Customer, Transaction or Delivery, `GET .../:id` responds 200 with that record serialized into exactly its documented response shape (Product per Property 1's field set; Customer per Requirement 3.1's field set; Transaction per Requirement 9.1 excluding card token/External_Id/other card data; Delivery per Requirement 11.1).

**Validates: Requirements 1.5, 3.9, 9.1, 9.9, 11.1** (numRuns: 25, HTTP)

### Property 3: An id that matches no record always yields the resource's not-found code

For any of {Product, Customer, Transaction, Delivery} and any id value that matches no stored record — including a value that is not even a validly formatted id — `GET .../:id` responds 404 with that resource's dedicated not-found code (`PRODUCT_NOT_FOUND`, `CUSTOMER_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `DELIVERY_NOT_FOUND`) and never a 500.

**Validates: Requirements 1.6, 3.10, 9.2, 11.2** (numRuns: 25, HTTP)

### Property 4: Strongly consistent product reads

For any product list/detail request, the repository call to DynamoDB is made with `ConsistentRead: true`.

**Validates: Requirements 1.7** (numRuns: 100, adapter-level with `aws-sdk-client-mock`, no HTTP)

### Property 5: Fees echo the configured values

For any valid configured pair of `(baseFeeInCents, deliveryFeeInCents)`, including the documented defaults, `GET /fees` responds 200 with `currency: "COP"` and exactly those two values.

**Validates: Requirements 2.1, 2.2** (numRuns: 25, HTTP)

### Property 6: Customer upsert is a normalized-email round trip

For any valid customer payload and any email written with extra surrounding whitespace or mixed case, creating then re-upserting with an email that normalizes to the same value updates the same record (same `id`, unchanged `createdAt`, updated other fields, 200); an email that has never been seen before (after normalization) always creates a new record (201).

**Validates: Requirements 3.1, 3.2, 3.3** (numRuns: 25, HTTP)

### Property 7: Field-level validation rejects out-of-rule values and names the field

For any request body to `POST /customers` or `POST /transactions` where exactly one field violates its documented rule (`fullName` 3-80 chars, `email` format/length, `phone` 10 digits starting with 3, `documentType` enum, `documentNumber` per `documentType`, `quantity` 1-5, `payment.installments` 1-36, `payment.brand` enum, `payment.lastFour` 4 digits, each `delivery.*` field rule, and the `Idempotency-Key` charset/length rule), the API responds 400 `VALIDATION_ERROR` with a `details` entry naming that field and its violated rule.

**Validates: Requirements 3.4, 3.5, 3.6, 3.7, 3.8, 5.2, 5.3, 5.4, 6.2, 13.7** (numRuns: 25, HTTP)

### Property 8: Unknown or malformed request bodies are rejected on customers and transactions

For any `POST /customers` or `POST /transactions` body that adds a property the DTO does not declare (including an `amount`-shaped property), the API responds 400 `VALIDATION_ERROR` and performs no write. This property belongs to the non-webhook branches (`feat/HU-09-customers-acceptance`, `feat/HU-09-transactions`); the complementary rule that the webhook DTO accepts undeclared properties is a separate, webhook-only property (Property 35).

**Validates: Requirements 5.5, 14.6** (numRuns: 25, HTTP)

### Property 9: Provider resilience policy is profile-specific

For any simulated sequence of Provider responses to a call made under the Standard_Profile (acceptance tokens or create), the adapter issues a second attempt if and only if the first attempt timed out or returned 5xx, never retries after a 4xx, and never issues a third attempt. For any simulated Provider response to a call made under the Single_Attempt_Profile (status by External_Id, or lookup by Reference — both only ever called from `GET /transactions/:id`), the adapter sends exactly one attempt with a 3 s timeout and never retries, regardless of the outcome.

**Validates: Requirements 4.2, 4.3, 8.3, 9.3** (numRuns: 100, adapter-level with `nock`/`msw`, no HTTP)

### Property 10: Insufficient stock blocks transaction creation without side effects

For any Product/quantity pair where `stock < quantity`, `POST /transactions` responds 409 `INSUFFICIENT_STOCK` naming the available units, and creates no Transaction, no Delivery, and sends no request to the Provider.

**Validates: Requirements 5.8** (numRuns: 25, HTTP)

### Property 11: Referential validation gates transaction creation

For any `POST /transactions` body whose `productId` or `customerId` matches no record, the API responds 404 (`PRODUCT_NOT_FOUND`/`CUSTOMER_NOT_FOUND`) before computing any amount or writing any record.

**Validates: Requirements 5.6, 5.7** (numRuns: 25, HTTP)

### Property 12: Amounts invariant

For any non-negative integer `unitPriceInCents`, integer `quantity` in [1,5], and non-negative integer fees, `subtotalInCents = unitPriceInCents × quantity` and `totalInCents = subtotalInCents + baseFeeInCents + deliveryFeeInCents`, exactly, with every value an integer (no rounding). The known vector 12,000,000 × 2 + 300,000 + 800,000 = 25,100,000 is one concrete instance.

**Validates: Requirements 5.9, 5.10, 21.2** (numRuns: 100, pure function)

### Property 13: PENDING persistence happens before any Provider call

For any valid transaction-creation request, the Delivery and Transaction are both written in PENDING with a fresh `Reference`, and the Idempotency_Record is updated with the new Transaction id, strictly before `PaymentGateway.create` is invoked.

**Validates: Requirements 5.11, 6.3, 6.8** (numRuns: 25, HTTP)

### Property 14: Created transactions never retain card data or secrets

For any valid transaction-creation request, no DynamoDB item, no log line and no HTTP response produced during processing contains the raw card token, card number, CVC, expiry date, the Provider private key, the integrity secret, or the events secret.

**Validates: Requirements 5.13, 7.9** (numRuns: 25, HTTP)

### Property 15: Stock is unchanged for any non-final transaction

For any Transaction whose status is still PENDING (Provider pending, or unreachable after retry), the Product's `stock` value is identical before and after the request.

**Validates: Requirements 5.15** (numRuns: 25, HTTP)

### Property 16: Idempotency key format is enforced

For any `POST /transactions` request with a missing or empty `Idempotency-Key`, the API responds 400 `MISSING_IDEMPOTENCY_KEY`; for any key outside 8-128 characters of `[A-Za-z0-9._-]`, it responds 400 `VALIDATION_ERROR` (subsumed by Property 7).

**Validates: Requirements 6.1** (numRuns: 25, HTTP)

### Property 17: Idempotent replay produces exactly one transaction and one Provider call

For any valid `Idempotency-Key` and request body, sending the same request twice (sequentially) results in exactly one created Transaction and exactly one `PaymentGateway.create` invocation; the second response is the stored response from the first (with a stored 201 replayed as 200).

**Validates: Requirements 6.6, 6.7, 21.4** (numRuns: 25, HTTP)

### Property 18: A different body under a reused key is rejected

For any `Idempotency-Key` already associated with a completed or in-progress request, a second request using the same key but a body that canonicalizes to a different hash responds 422 `IDEMPOTENCY_KEY_REUSED` and creates no new Transaction.

**Validates: Requirements 6.4** (numRuns: 25, HTTP)

### Property 19: A concurrent identical request is rejected while in progress

For any `Idempotency-Key`/body pair whose first request is still `IN_PROGRESS` and younger than the Lambda timeout, a second identical request responds 409 `IDEMPOTENCY_KEY_IN_PROGRESS` and never calls the Provider.

**Validates: Requirements 6.5** (numRuns: 25, HTTP)

### Property 20: Stale in-progress records recover without duplicating work

For any `IN_PROGRESS` record older than the Lambda timeout: if it already has a Transaction id, a repeated request responds 200 with that Transaction's current state and performs no new write; if it has no Transaction id, a repeated request takes over the record (conditional on `createdAt`) and reprocesses exactly once even if two requests race to take it over.

**Validates: Requirements 6.9, 6.10** (numRuns: 25, HTTP)

### Property 21: Pre-write failures leave the idempotency key reusable

For any business-error outcome that occurs before the PENDING Transaction is persisted, the Idempotency_Record for that key is deleted, so a subsequent request with the same key is processed as if it were new.

**Validates: Requirements 6.11** (numRuns: 25, HTTP)

### Property 22: Request-hash canonicalization is key-order independent

For any JSON object and any permutation of its top-level (and nested) key order, the computed Request_Hash is identical.

**Validates: Requirements 6.13, 21.11** (numRuns: 100, pure function)

### Property 23: Integrity signature and event checksum match their formulas

For any `(reference, amountInCents, currency, secret)` tuple, `computeIntegritySignature` equals `sha256hex(reference + amountInCents + currency + secret)`. For any `(signatureProperties, timestamp, secret)` tuple, `computeEventChecksum` equals `sha256hex` of those values concatenated in order. Known vectors for both are included as fixed examples.

**Validates: Requirements 7.2, 12.2, 21.3** (numRuns: 100, pure function)

### Property 24: Provider acceptance updates the transaction according to its reported status

For any Provider "create" response that is accepted (2xx): if it reports PENDING, the API records the External_Id and responds 201 PENDING; if it reports a Final_Status, the Amount_Check and `FinalizeTransaction` run before the response, and the resulting status is what the response carries. The same status-driven finalization applies identically when the status instead arrives via `SyncTransactionStatus`. This property covers the create and sync branches (`feat/HU-09-transactions`, `feat/HU-11-sync-deliveries`); the equivalent webhook behavior is Property 35's concern, not this one's.

**Validates: Requirements 7.3, 7.4, 7.5, 9.5** (numRuns: 25, HTTP)

### Property 25: A 4xx on the first attempt marks the transaction ERROR; a 4xx on the retry after an unreachable first attempt stays PENDING for later reconciliation

For any Provider "create" call whose first attempt ends in HTTP 4xx with no prior timeout/5xx, the Transaction becomes ERROR with the Provider message as `statusReason`, the Delivery becomes CANCELLED, stock is unchanged, and the response is 502 `PAYMENT_PROVIDER_ERROR`. For any Provider "create" call whose first attempt times out or returns 5xx and whose retry then answers HTTP 4xx, the API runs no Reconciliation and sends no further Provider request within that call: the Transaction stays PENDING without an External_Id, the Delivery stays PENDING, and the response is 201 PENDING — any reconciliation happens later, only from `GET /transactions/:id`.

**Validates: Requirements 7.6, 7.7, 8.1, 8.2** (numRuns: 25, HTTP)

### Property 26: An unreachable Provider never produces a second charge for the same reference

For any Reference, across its creation attempt (one call plus at most one retry) and any number of later `GET /transactions/:id` calls and webhook deliveries, `PaymentGateway.create` is invoked at most once in total.

**Validates: Requirements 8.2** (numRuns: 25, HTTP)

### Property 27: Reconciliation outcomes are applied correctly and only when needed

For any Transaction that is PENDING without an External_Id: a `GET` request triggers `findByReference` under the Single_Attempt_Profile; if it reports `found`, the External_Id is stored and the resulting status is applied via the Amount_Check and Finalization; if it reports `not_found` and the Transaction's age is at least the Reconciliation_Window (60 s), the Transaction becomes ERROR with reason `PROVIDER_UNREACHABLE`, the Delivery becomes CANCELLED, and stock is unchanged; if it reports `not_found` and the Transaction is younger than the window, it stays PENDING and the response is 200 with the stored state; if the lookup itself fails after its single attempt, the Transaction stays PENDING, the response is 200, and a warning is logged.

**Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.7** (numRuns: 25, HTTP)

### Property 28: Provider sync is throttled to once per second and skipped once final

For any PENDING Transaction with an External_Id, a `GET` request calls the Provider only when `lastSyncedAt` is at least 1 s old (and updates `lastSyncedAt` when it does); once a Transaction reaches any Final_Status, no later `GET` ever calls the Provider again, no matter how many times it is requested.

**Validates: Requirements 9.3, 9.4, 9.6** (numRuns: 25, HTTP)

### Property 29: Unrecognized Provider status values are rejected safely

For any string the Provider reports as a transaction status that is not one of PENDING/APPROVED/DECLINED/VOIDED/ERROR, the Transaction stays PENDING and a warning is logged; the response is never a crash or an unmapped status value.

**Validates: Requirements 9.8** (numRuns: 25, HTTP)

### Property 30: Finalization applies the correct side effects per outcome

For any PENDING Transaction and any Final_Status whose Amount_Check matches: APPROVED results in Transaction APPROVED, Delivery ASSIGNED, and `stock -= quantity`; DECLINED/VOIDED/ERROR result in the same Transaction status, Delivery CANCELLED, unchanged stock, and the Provider message stored as `statusReason`; `finalizedAt` is set in every case.

**Validates: Requirements 10.1, 10.2, 10.4** (numRuns: 100, use-case/adapter level with `aws-sdk-client-mock`, no HTTP)

### Property 31: Finalization is idempotent

For any Transaction that already has a Final_Status, invoking Finalization again (with any status) changes no item and returns the already-stored state — running it once or a hundred times produces the same stock, the same Delivery status and the same Transaction status.

**Validates: Requirements 10.6** (numRuns: 100, use-case/adapter level with `aws-sdk-client-mock`, no HTTP)

### Property 32: The transition functions only allow the documented moves

For any `(from, to)` pair of statuses, `canTransitionTransaction` is true only for `from = PENDING` and `to` a Final_Status, and `canTransitionDelivery` is true only for `from = PENDING` and `to` one of ASSIGNED/BACKORDER/CANCELLED; every other pair, including any final-to-final or final-to-PENDING pair, is false.

**Validates: Requirements 10.7** (numRuns: 100, pure function)

### Property 33: Approval without enough stock produces BACKORDER, never negative stock

For any APPROVED outcome where the Product's current stock is lower than the Transaction's quantity, the Transaction still becomes APPROVED, the Delivery becomes BACKORDER (not ASSIGNED, not CANCELLED), stock is unchanged, and an alert log entry is written with the Reference and product id. Under any number of concurrent Finalizations racing on the same product, stock never goes below 0.

**Validates: Requirements 10.5, 10.8** (numRuns: 100, use-case/adapter level with `aws-sdk-client-mock`, no HTTP)

### Property 34: Webhook checksum gates every state change

For any webhook body and any candidate checksum (from the `X-Event-Checksum` header when present, otherwise from `signature.checksum`), the request is accepted and processed only when the candidate exactly equals the value computed from Property 23's formula under a constant-time comparison; any missing or mismatching checksum responds 401 `INVALID_SIGNATURE` and changes no stored state, regardless of how plausible the rest of the body looks.

**Validates: Requirements 12.3, 12.4** (numRuns: 25, HTTP)

### Property 35: Webhook events apply Finalization exactly once, tolerate undeclared properties, and never move a transaction backward

For any valid (checksum-verified) `transaction.updated` event targeting a PENDING Transaction: the Amount_Check and Finalization of Requirement 10 run against the event's reported status before responding 200, exactly as for the creation response and the status sync (Property 24). For any such event whose Reference matches no Transaction, the API responds 200 and changes no state. For any such event whose Reference is already in a Final_Status and whose status differs from the event's status, the API responds 200, logs a warning, and changes no state. For any such event whose Reference is PENDING without an External_Id, the API stores the External_Id from the event. For any event whose type is not `transaction.updated`, the API responds 200 and changes no state. For any such event body that additionally carries a property the webhook DTO does not declare, the request is processed exactly as if that property were absent. Together with Property 34 and the event-checksum part of Property 23, this property belongs to the `feat/HU-13-payment-webhook` branch; every non-webhook rule exercised elsewhere in this list (unknown-property rejection, create-and-sync status handling, the no-throw rule) is tested in its own non-webhook branch instead.

**Validates: Requirements 12.1, 12.5, 12.6, 12.7, 12.8, 12.9** (numRuns: 25, HTTP)

### Property 36: Every error response uses the fixed envelope and the documented status

For any 4xx/5xx outcome produced anywhere in the API, the body is exactly `{ statusCode, code, message, details }`, `statusCode` matches the documented mapping for `code` (Requirement 13.3's table), and `message` is the fixed string for that code — it never contains any value taken from the triggering request (tested by injecting adversarial strings such as the request path, header values, or body fields and asserting none of them appear in the response message).

**Validates: Requirements 13.1, 13.3, 13.4, 13.6, 13.8** (numRuns: 25, HTTP)

### Property 37: The media-type guard accepts exactly `application/json` with an absent or `utf-8` charset, case-insensitively, and rejects everything else before any body parsing

For any `POST` request with a body, parse its `Content-Type` into a media type and parameters (never compare the raw header string): if the media type compares case-insensitively equal to `application/json` and the `charset` parameter is either absent or compares case-insensitively equal to `utf-8`, the API accepts the content type and continues the request; for any other media type, any other `charset` value, or a missing `Content-Type` header, the API responds 415 `UNSUPPORTED_MEDIA_TYPE` without parsing the body.

**Validates: Requirements 13.5, 13.10, 13.11** (numRuns: 25, HTTP)

### Property 38: Every response carries a request id, and the origin guard is absolute

For any request, successful or not, the response carries `X-Request-Id`. For any request to a business or webhook route lacking a valid `X-Origin-Verify` header, the response is 403 `FORBIDDEN_ORIGIN` regardless of how well-formed the rest of the request is.

**Validates: Requirements 14.1, 14.2** (numRuns: 25, HTTP)

### Property 39: Log masking is a pure, lossy function of its input

For any email, the logged form keeps exactly the first character of the local part, then `***`, then the unchanged domain. For any document number, the logged form replaces every character except the last three with `*`, preserving length and the last three characters exactly.

**Validates: Requirements 14.4, 14.5** (numRuns: 100, pure function)

### Property 40: The rate limiter enforces exactly 60 requests per 60 s per Client_IP, and never counts `GET /health`

For any Client_IP and any sequence of requests to a counted route within one 60 s window, the 61st and later requests respond 429 `TOO_MANY_REQUESTS` while the first 60 succeed (subject to their own business logic); a different Client_IP has an independent counter. For any number of `GET /api/v1/health` requests from the same Client_IP within the same window, none of them counts toward that limit and none of them is ever answered 429.

**Validates: Requirements 15.1, 15.2, 15.12** (numRuns: 25, HTTP)

### Property 41: Client IP parsing splits at the last colon, with a safe fallback

For any `CloudFront-Viewer-Address` value that contains at least one `:` (IPv4:port or any IPv6[:port] form), the derived Client_IP is everything before the last `:`. For any value with no `:`, or when the header is absent, the derived Client_IP is the raw socket address. For any value supplied in a client-sent `X-Forwarded-For` header, it has no effect on the derived Client_IP under any circumstance.

**Validates: Requirements 15.3, 15.4, 15.5, 15.6, 21.10** (numRuns: 100, pure function)

### Property 42: Use cases and adapters never throw for business failures

For any input that triggers a documented business error in any non-webhook Use_Case or adapter (`GetProducts`, `GetProduct`, `GetFees`, `UpsertCustomer`, `GetCustomer`, `GetAcceptanceTokens`, `CreateTransaction`, `SyncTransactionStatus`, `FinalizeTransaction`, `GetDelivery`, and every repository/gateway adapter), the call resolves to an `Err` Result; it is never a rejected promise or a thrown exception reaching the controller. This property-based test belongs to the non-webhook branches. `HandlePaymentEvent` is held to the same rule by Requirement 17.10, but it is exercised only by the `feat/HU-13-payment-webhook` branch's own example-based tests (checksum failure, unknown Reference, stale status), not by this property.

**Validates: Requirements 17.4** (numRuns: 100, use-case level with in-memory fakes, no HTTP)

### Property 43: Unexpected adapter failures are translated, never leaked

For any adapter call that fails with an error outside the documented repository/gateway error shapes, the use case receives a generic `REPOSITORY_ERROR`/`PAYMENT_GATEWAY_ERROR` `Err`, and the HTTP response is 500 `INTERNAL_ERROR` with no trace of the original exception's message or stack.

**Validates: Requirements 17.9** (numRuns: 100, adapter-level with `aws-sdk-client-mock`/`nock`, no HTTP)

### Property 44: The SPA rewrite function is provably inert for `/api/` and `/docs/`

For any request URI, including extension-less ones, that starts with `/api/` or `/docs/`, `spa_rewrite` returns the request unchanged; for every other extension-less URI, it rewrites to `/index.html`.

**Validates: Requirements 18.8** (numRuns: 100, pure function)

### Property 45: The docs index function rewrites only the two bare docs paths

For any request URI, `docs_index_rewrite` rewrites it to `/docs/index.html` if and only if the URI is exactly `/docs` or exactly `/docs/`; every other URI (in particular every real asset under `/docs/*`) is returned unchanged.

**Validates: Requirements 18.9** (numRuns: 100, pure function)

### Property 46: Amount_Check gates finalization, overriding even an APPROVED report

For any Provider-reported status about to be finalized — from the creation response, the status sync, or the webhook — whose `amount_in_cents`, `currency` or `reference` differs from the stored Transaction's `totalInCents`, currency or Reference, Finalization always produces ERROR with `statusReason` `AMOUNT_MISMATCH`, Delivery CANCELLED and unchanged stock, even when the Provider reports APPROVED, and writes an alert log entry naming the Reference and the mismatched field names. For any Provider-reported status whose three fields match the stored Transaction exactly, Finalization proceeds with the originally reported status as in Property 24/35. This property sits immediately before step 4 of the Finalization algorithm, so it runs for all three callers (create, sync, webhook) through the one shared `FinalizeTransaction` use case.

**Validates: Requirements 10.9, 10.10, 10.11** (numRuns: 100, pure function `checkAmount` plus a `FinalizeTransaction` orchestration check with in-memory fakes, no HTTP)
