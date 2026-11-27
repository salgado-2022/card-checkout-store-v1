# Design Document

## Overview

This design implements the platform foundation of the card checkout store: the monorepo layout, code-quality tooling, test coverage gates, the CI pipeline, the hexagonal dependency rule, the zero-cost AWS infrastructure (Terraform), a minimal deployed web skeleton, and the `GET /api/v1/health` endpoint reachable through CloudFront with the `X-Origin-Verify` origin guard.

The architecture decisions below are already fixed by the source requirements and are transcribed as-is, not re-derived. No alternatives are proposed.

**Core idea:** one CloudFront distribution serves the web build from a private S3 bucket (OAC) and routes `/api/*` to a Lambda Function URL running NestJS (Express adapter) bundled with esbuild. Front and API share one HTTPS domain (`*.cloudfront.net`), so no CORS is needed. CloudFront injects a shared secret as the `X-Origin-Verify` header on every request to the Lambda origin; the API's `OriginGuardMiddleware` rejects any request lacking the correct header with 403, so the Lambda Function URL cannot be called directly. All services stay inside the AWS always-free tier: DynamoDB provisioned capacity (12 RCU / 12 WCU of a 25/25 budget), CloudWatch Logs with 7-day retention, SSM standard SecureString parameters, and a CloudFront Function (not Lambda@Edge) for the SPA rewrite.

## Architecture

```text
Browser
  │  HTTPS (single domain, *.cloudfront.net)
  ▼
CloudFront Distribution
  ├─ Response Headers Policy (HSTS, CSP, nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy)
  ├─ Default behavior  → S3 Web_Bucket (OAC)        + CloudFront Function: SPA_Rewrite_Function
  └─ /api/* behavior   → Lambda Function URL        + custom origin header X-Origin-Verify: <secret>
                                                        (caching disabled on this behavior)
                              │
                              ▼
                     Lambda_Function (Node.js 22, 512 MB, 15 s timeout)
                       NestJS app (Express adapter), bundled by esbuild as lambda.js
                       OriginGuardMiddleware → 403 if X-Origin-Verify missing/invalid
                       GET /api/v1/health → { "status": "ok" }
                              │
                   ┌──────────┼───────────────┐
                   ▼          ▼               ▼
                 SSM      DynamoDB        CloudWatch Logs
            (SecureString  (5 tables,     (log group, 7-day
             parameters,   provisioned     retention)
             read once per capacity)
             cold start)
```

Deployment is automatic and code-based. The Developer runs a one-time apply of `infra/bootstrap` (local state, git-ignored) that creates the State_Bucket, the GitHub_OIDC_Provider and the Deploy_Role. From then on, `.github/workflows/deploy.yml` runs after a green `ci.yml` on `master` (or on manual dispatch), authenticates with OIDC (no access keys), plans for review, waits for approval on the `production` GitHub Environment, re-plans and applies inside the approved job, deploys the Lambda bundle, uploads the web build to S3, invalidates CloudFront and runs a smoke test. Before the first deploy the Developer creates the three Payment_Secret_Parameters in SSM with the AWS CLI; Terraform only references them by name, so their values never enter the state or a plan. No agent runs `terraform apply` or `terraform destroy`, no workflow runs `terraform destroy`, and `ci.yml` never touches AWS or secrets (Requirements 15, 19 to 24).

### Deployment flow

```text
Developer (once, local)           GitHub Actions deploy.yml                           AWS
-----------------------           -------------------------                           ---
terraform apply infra/bootstrap -> State_Bucket, OIDC provider, Deploy_Role
                                  ci.yml green on master (workflow_run) / workflow_dispatch
                                  plan (OIDC) -> fmt, init, validate, plan -> job summary only (no artifact)
                                  apply  [environment: production, approval] -> plan -out=tfplan + apply tfplan (same job)
                                  deploy-api  -> esbuild + zip -> lambda update-function-code -> wait updated
                                  deploy-web  -> vite build -> s3 sync (cache-control) -> CloudFront invalidation
                                  smoke-test  -> curl / and /api/v1/health (no X-Origin-Verify), up to 5 tries
Developer (before 1st deploy)  -> creates 3 payment secrets in SSM with the AWS CLI (never in Terraform)
```

### Why this shape (transcribed from the source architecture decision)

- A single CloudFront distribution in front of S3 and a Lambda Function URL keeps front and API on the same HTTPS domain, avoiding CORS, using the free `*.cloudfront.net` certificate, and centralizing security headers in one Response Headers Policy.
- The CloudFront Function (not "custom error responses") performs the SPA rewrite, because custom error responses apply to the whole distribution and would turn API 404s into the SPA's `index.html`.
- The origin is protected with a secret header injected by CloudFront rather than with CloudFront's OAC-for-Lambda-URL mechanism, because OAC would require the payment webhook caller to sign requests with `x-amz-content-sha256`, which the payment provider's webhook cannot do.
- DynamoDB runs in provisioned capacity (not on-demand) because only provisioned capacity falls inside the AWS always-free tier (25 RCU / 25 WCU / 25 GB).

## Monorepo Structure

```text
/
  api/
    src/
      domain/                        entities, value objects (Money, CardBrand, TransactionStatus), domain errors, Result re-exports
      application/
        ports/                       ProductRepository, CustomerRepository, TransactionRepository, DeliveryRepository,
                                      IdempotencyRepository, PaymentGateway, Clock, IdGenerator
        use-cases/                   (populated by later specs; empty with a .gitkeep/README for this spec)
      infrastructure/
        http/
          controllers/               health.controller.ts
          filters/                   result-exception.filter.ts (Result → HTTP mapper, shared error shape)
          middleware/                origin-guard.middleware.ts
        persistence/                 (DynamoDB adapters; populated by later specs)
        payment/                     (payment gateway adapter; populated by later specs)
        config/
          env.schema.ts              zod/class-validator schema for all required env vars
          env.config.ts              loads + validates env, returns Result<AppConfig, ConfigError>
          origin-secret.provider.ts  reads ORIGIN_VERIFY_SECRET_PARAM from SSM once per cold start, caches in module scope
      app.module.ts
      main.ts                        local/dev bootstrap (excluded from coverage)
      lambda.ts                      Lambda handler, reuses one NestJS instance across invocations (excluded from coverage)
    test/                            or co-located *.spec.ts next to sources
    scripts/
      seed.ts                        (stub for this spec; populated by later specs, excluded from coverage)
      build-lambda.ts                tsc emit + esbuild bundle into dist/lambda.js (see Lambda bundle)
    eslint.config.mjs
    .prettierrc
    .dependency-cruiser.cjs
    jest.config.ts
    tsconfig.json
    tsconfig.build.json              emit used before the esbuild bundle (keeps decorator metadata)
    package.json
    .nvmrc
  web/
    src/
      app/
        store.ts                     Redux Toolkit store
        App.tsx                      placeholder page shell
        main.tsx                     entry point (excluded from coverage)
      features/
        product/                     (stub folder for this spec; populated by later specs)
        checkout/                    (stub folder for this spec; populated by later specs)
        transaction/                 (stub folder for this spec; populated by later specs)
      shared/
        api/
          client.ts                  fetch wrapper reading VITE_API_BASE
    index.html
    eslint.config.mjs
    .prettierrc
    jest.config.ts
    tsconfig.json
    vite.config.ts
    package.json
    .nvmrc
  infra/
    main.tf
    providers.tf                     AWS provider (us-east-2), random provider, partial `backend "s3"` block (no bucket name)
    variables.tf                     budget_notification_email, payment_api_url, payment_public_key, project_name, placeholder settings
    outputs.tf                       distribution_domain_name, distribution_id, web_bucket_name, lambda_function_name
    s3.tf                            Web_Bucket + bucket policy restricted to the Distribution via OAC
    cloudfront.tf                    Distribution, OAC, Response Headers Policy, cache behaviors
    cloudfront_function.tf           SPA_Rewrite_Function source + association
    lambda.tf                        Lambda_Function, Function URL, IAM role/policy, log group (7-day retention)
    dynamodb.tf                      5 tables with provisioned capacity, GSIs, TTL on idempotency_keys
    ssm.tf                           origin secret via random_password; payment parameters are created by the Developer and referenced by name only
    budget.tf                        AWS Budget at 1 USD/month, 80% actual + 100% forecasted alerts
    README.md                        short pointer to docs/deployment.md and local validate commands
    bootstrap/                       one-time module, LOCAL state (git-ignored)
      main.tf                        State_Bucket, GitHub_OIDC_Provider, Deploy_Role, Deploy_Role policy
      variables.tf                   github_owner, github_owner_id, github_repo, github_repo_id, state_bucket_name, project_name
      outputs.tf                     deploy_role_arn, state_bucket_name
  docs/
    deployment.md                    one-time manual setup, Deploy_Variables table, first deploy, secret replacement, manual smoke test
    architecture.md                  (optional diagram reference)
  scripts/
    check-forbidden-words.sh         (existing)
  .github/
    pull_request_template.md         PR template (user story id + Quality_Gates evidence)
    workflows/
      ci.yml                         lint/typecheck/test/build/dependency-cruiser/gitleaks/forbidden-words, per project; no AWS, no secrets
      deploy.yml                     plan -> apply -> deploy-api -> deploy-web -> smoke-test
  .githooks/
    commit-msg                       (existing)
    pre-commit                       (existing)
  .env.example
  .gitignore
  README.md
```

`api/src/application/use-cases` and the three `web/src/features/*` folders are created empty (with a `.gitkeep` or a one-line `README.md`) in this spec; they are populated by later specs and are not part of this spec's acceptance criteria.

## Components and Interfaces

### API bootstrap (`main.ts` / `lambda.ts`)

- `main.ts`: local entry point. Calls `loadConfig()`, exits with a named error if it returns `Err`, otherwise creates the Nest app, applies global `ValidationPipe` and the exception filter, and calls `app.listen()`. Excluded from coverage (wiring only).
- `lambda.ts`: Lambda handler. Keeps the created Nest `Handler` adapter in a module-level variable (`let cachedServer`). On cold start it builds the app once (`NestFactory.create` + `app.init()`), wraps it in a serverless HTTP adapter, and reuses `cachedServer` on every subsequent invocation of the same container, satisfying Requirement 10.2. Excluded from coverage.

```typescript
// api/src/lambda.ts (shape, not full implementation)
import type { Handler } from 'aws-lambda';
import type { Server } from 'http';

let cachedServer: Server | undefined;

async function bootstrapServer(): Promise<Server> {
  const configResult = loadConfig();
  if (configResult.isErr()) {
    throw new Error(`Invalid configuration: ${configResult.error.variableName}`);
  }
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.useGlobalFilters(new ResultExceptionFilter());
  await app.init();
  return createLambdaServer(app); // wraps Express instance for Lambda Function URL events
}

export const handler: Handler = async (event, context) => {
  cachedServer ??= await bootstrapServer();
  return proxyLambdaRequest(cachedServer, event, context);
};
```

### Lambda bundle (`api/scripts/build-lambda.ts`)

esbuild does not implement TypeScript's `emitDecoratorMetadata`, and NestJS resolves constructor dependencies from that metadata. Bundling the TypeScript sources directly would pass every `ts-jest` test and still fail at runtime in Lambda. The build therefore runs in two steps (Requirement 10.1):

1. `tsc -p tsconfig.build.json` emits CommonJS JavaScript with decorator metadata into `api/build/` (git-ignored).
2. esbuild bundles `build/lambda.js` into `dist/lambda.js` (`platform: 'node'`, `target: 'node22'`, `format: 'cjs'`, minified, no source maps uploaded). The optional NestJS packages the app does not use (`@nestjs/microservices`, `@nestjs/microservices/microservices-module`, `@nestjs/websockets`, `@nestjs/websockets/socket-module`, `class-transformer/storage`) are marked `external`; Nest only loads them when used.

A bundled-boot integration test requires `dist/lambda.js`, invokes `handler` with a Lambda Function URL (payload v2) event for `GET /api/v1/health` carrying a valid `X-Origin-Verify`, and expects status 200 (Requirement 10.1a). SSM is answered by a local HTTP stub through the SDK's `AWS_ENDPOINT_URL_SSM` variable with dummy credentials, so no AWS call is made.

### Configuration module (`infrastructure/config`)

- `env.schema.ts` declares every required variable from Requirement 7.1 plus the DynamoDB table names, with defaults `BASE_FEE_IN_CENTS=300000` and `DELIVERY_FEE_IN_CENTS=800000` (Requirement 7.3).
- `env.config.ts` exposes `loadConfig(): Result<AppConfig, ConfigError>`. It never throws; only `main.ts`/`lambda.ts` convert an `Err` into a thrown startup error, satisfying the ROP boundary from Requirement 7.4.
- `ConfigError` carries the offending variable name only — never a value — so the startup log line stays free of secrets (Requirement 7.2, Requirement 17.2).

```typescript
export interface AppConfig {
  paymentApiUrl: string;
  paymentPublicKey: string;
  paymentPrivateKeyParam: string;
  paymentIntegritySecretParam: string;
  paymentEventsSecretParam: string;
  originVerifySecretParam: string;
  baseFeeInCents: number;
  deliveryFeeInCents: number;
  tables: { products: string; customers: string; transactions: string; deliveries: string; idempotencyKeys: string };
}

export interface ConfigError {
  readonly kind: 'MISSING_ENV_VAR' | 'INVALID_ENV_VAR';
  readonly variableName: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Result<AppConfig, ConfigError> { /* ... */ }
```

- `origin-secret.provider.ts` reads `ORIGIN_VERIFY_SECRET_PARAM` from SSM with `@aws-sdk/client-ssm` (`WithDecryption: true`) exactly once per Lambda container, caching the resolved value in a module-level variable (Requirement 7.5). If the SSM read fails at startup, the provider surfaces an error that is logged with only the parameter name and causes startup to fail (Requirement 9.7).

### Origin guard (`infrastructure/http/middleware/origin-guard.middleware.ts`)

Implemented as a global Nest middleware (applied in `AppModule.configure` to every route, so later routes such as the payment webhook inherit it automatically — Requirement 9.6).

```typescript
@Injectable()
export class OriginGuardMiddleware implements NestMiddleware {
  constructor(private readonly originSecret: OriginSecretProvider) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const received = req.header('x-origin-verify');
    if (!received) {
      this.logRejection(req, 'missing_header');
      return this.reject(res);
    }
    if (!timingSafeEqualStrings(received, this.originSecret.get())) {
      this.logRejection(req, 'invalid_header');
      return this.reject(res);
    }
    next();
  }

  private reject(res: Response): void {
    res.status(403).json({ statusCode: 403, code: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed.', details: [] });
  }

  private logRejection(req: Request, reason: 'missing_header' | 'invalid_header'): void {
    logger.warn({ requestId: req.header('x-request-id') ?? randomRequestId(), reason });
  }
}
```

`timingSafeEqualStrings` wraps Node's `crypto.timingSafeEqual` after padding/hashing both inputs to equal length, satisfying the constant-time comparison in Requirement 9.4. The 403 body matches the fixed error shape and never includes the expected or received value (Requirement 9.5).

### Health endpoint (`infrastructure/http/controllers/health.controller.ts`)

```typescript
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

No dependency on DynamoDB, SSM, or the payment gateway is injected into this controller, so it cannot perform I/O at request time (Requirement 8.2). A global `RequestIdMiddleware` (also applied in `AppModule.configure`, ordered before the origin guard or as part of the same pipeline) reads `X-Request-Id` from the incoming request or generates one with `crypto.randomUUID()`, and sets it on the response for every route (Requirement 8.4). A global prefix `api/v1` is set once in `main.ts`/`lambda.ts` via `app.setGlobalPrefix('api/v1')` (Requirement 8.3).

### Result → HTTP mapping (`infrastructure/http/filters/result-exception.filter.ts`)

A single Nest exception filter translates domain/application errors into the fixed error shape `{ statusCode, code, message, details }`, strips stack traces from every response body (Requirement 8.6, Requirement 10.6), and logs the full error server-side as structured JSON (Requirement 17.1) without ever logging the `X-Origin-Verify` value or a payment token (Requirement 17.2).

### Logging

A minimal JSON logger (either Nest's built-in logger configured with a JSON formatter, or a small wrapper) writes one line per request with `requestId`, `method`, `path`, `statusCode`, and `durationMs` (Requirement 17.1). It is implemented in `infrastructure/http` as middleware that records the start time and logs on the `res.on('finish')` event.

### Web skeleton (`web/src`)

- `app/store.ts`: `configureStore` from Redux Toolkit with a single placeholder reducer (or an empty root reducer ready for `features/*` slices added by later specs).
- `app/App.tsx`: renders one placeholder page with a Spanish-language visible title (Requirement 11.2), inside a CSS Modules file using flexbox/grid only.
- `shared/api/client.ts`: reads `import.meta.env.VITE_API_BASE` (expected value `/api/v1`) and exposes a thin `fetch` wrapper used by later specs (Requirement 11.5).
- Vite is used strictly as the bundler (no Next.js/Angular/Vue code, no heavy UI kit — Requirement 11.6); the production build emits hashed file names by default (Requirement 11.3).
- Responsive layout uses flexbox/grid with no fixed widths beyond the viewport, verified at 375–1440 px (Requirement 11.4).

## Terraform Modules (`infra/`)

All resources live under a flat root module in `infra/` (no nested module directories are required at this scale); files are split by concern as listed in the Monorepo Structure section.

| File | Resources | Key settings (fixed, not alternatives) |
|---|---|---|
| `providers.tf` | `terraform { backend "s3" { key, region, use_lockfile = true, encrypt = true } }`, `provider "aws"`, `provider "random"` | `region = "us-east-2"`; the bucket name is not in the code: it is passed as `-backend-config="bucket=..."` (together with key and region) from the workflow variables; no DynamoDB lock table |
| `s3.tf` | `aws_s3_bucket.web`, `aws_s3_bucket_public_access_block.web`, `aws_s3_bucket_policy.web` | All public access blocked; bucket policy allows `s3:GetObject` only for the CloudFront distribution's OAC service principal, scoped by `AWS:SourceArn` to the distribution |
| `cloudfront.tf` | `aws_cloudfront_distribution.web`, `aws_cloudfront_origin_access_control.web`, `aws_cloudfront_response_headers_policy.security` | Default behavior → S3 origin with OAC; `/api/*` ordered cache behavior → Lambda Function URL origin, `cache_policy_id` = CachingDisabled managed policy, custom origin header `X-Origin-Verify`; `viewer_protocol_policy = "redirect-to-https"`; default `*.cloudfront.net` certificate (`cloudfront_default_certificate = true`); no `custom_error_response` blocks |
| `cloudfront_function.tf` | `aws_cloudfront_function.spa_rewrite` | JS function associated to the default (S3) behavior's `viewer-request` event; rewrites extension-less, non-`/api/*` URIs to `/index.html` |
| `lambda.tf` | `aws_lambda_function.api`, `aws_lambda_function_url.api`, two `aws_lambda_permission` resources, `aws_iam_role.lambda_exec`, `aws_iam_role_policy.lambda_exec`, `aws_cloudwatch_log_group.api` | `runtime = "nodejs22.x"`, resource-based policy with both `lambda:InvokeFunctionUrl` (`principal = "*"`, `function_url_auth_type = "NONE"`) and `lambda:InvokeFunction` (`principal = "*"`, restricted to function URL invocations with `invoked_via_function_url = true` where the pinned AWS provider supports it), required for function URLs created since October 2025 (Requirement 12.7a); `memory_size = 512`, `timeout = 15`; Function URL with `authorization_type = "NONE"` (protected instead by the `X-Origin-Verify` header check inside the app); log group `retention_in_days = 7`; IAM policy grants only `ssm:GetParameter` on the 4 parameter ARNs, `dynamodb:*Item`/`Query` on the 5 table and index ARNs, and `logs:CreateLogStream`/`PutLogEvents` on its own log group |
| `dynamodb.tf` | 5 `aws_dynamodb_table` resources | `billing_mode = "PROVISIONED"`; no `autoscaling` resource attached, no `point_in_time_recovery` block (disabled by default); capacity per the table below; TTL block (`attribute_name = "expiresAt"`) only on `idempotency_keys` |
| `ssm.tf` | 1 origin `aws_ssm_parameter`, `random_password.origin_verify`, `locals` with the three payment parameter names | Origin parameter `/<project_name>/origin/verify-secret`, `type = "SecureString"`, default AWS-managed KMS key (no `key_id` override), value from `random_password.origin_verify` (length 48, no special characters), which also feeds the CloudFront custom header; outputs that expose it are `sensitive = true`. The three Payment_Secret_Parameters (`/<project_name>/payment/private-key`, `/<project_name>/payment/integrity-secret`, `/<project_name>/payment/events-secret`) are **not** Terraform resources or data sources: `locals` only build their names and ARNs for the Lambda environment and the IAM policy, so their values never enter the state or a plan (Requirement 12.11a) |
| `budget.tf` | `aws_budgets_budget.monthly_cap` | `limit_amount = "1"`, `limit_unit = "USD"`, `time_unit = "MONTHLY"`; two `notification` blocks: `ACTUAL` at 80%, `FORECASTED` at 100%; recipient email from `var.budget_notification_email` (no default — `terraform plan`/`validate` fails if unset) |
| `variables.tf` | — | `budget_notification_email` (no default), `payment_api_url`, `payment_public_key` (public value, non-secret placeholder default), `project_name` (resource name prefix); no secret variables |
| `outputs.tf` | — | `distribution_domain_name`, `distribution_id`, `web_bucket_name`, `lambda_function_name`; any output that exposes the origin secret is `sensitive = true` |

### DynamoDB capacity table (transcribed, not re-derived)

| Table | Key | Index | RCU | WCU |
|---|---|---|---|---|
| `products` | `id` (ULID) | — | 2 | 1 |
| `customers` | `id` (ULID) | GSI `email`: 1 RCU / 1 WCU | 2 | 2 |
| `transactions` | `id` (ULID) | GSI `reference`: 1 RCU / 1 WCU | 3 | 3 |
| `deliveries` | `id` (ULID) | — | 2 | 2 |
| `idempotency_keys` | `key` | TTL `expiresAt` | 1 | 2 |
| **Total** | | | **12** | **12** |

This leaves 13 RCU / 13 WCU of headroom under the always-free 25/25 cap (Requirement 16.3).

### Response Headers Policy (fixed header set)

`Strict-Transport-Security`, `Content-Security-Policy` (allows `script-src`/`style-src`/`img-src` from `'self'`, and `connect-src` from `'self'` plus the value of `VITE_PAYMENT_API_URL`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`. Attached once at the distribution level so both the S3 behavior and the `/api/*` behavior return the same six headers (Requirement 13.3–13.5).

## Jest Configuration

Both `api/jest.config.ts` and `web/jest.config.ts` use `ts-jest` (or `@swc/jest`) and set:

```typescript
coverageThreshold: {
  global: { statements: 80, branches: 80, functions: 80, lines: 80 },
},
// Requirement 3.2a: untested files count as 0% instead of being left out of the report.
collectCoverageFrom: ['<rootDir>/src/**/*.ts'], // web: '<rootDir>/src/**/*.{ts,tsx}'
coveragePathIgnorePatterns: [
  // api/jest.config.ts
  '/node_modules/', '<rootDir>/src/main.ts', '<rootDir>/src/lambda.ts',
  '<rootDir>/src/.*\\.module\\.ts$', '.*\\.d\\.ts$', '<rootDir>/scripts/seed.ts',
],
```

The web config mirrors this with `'<rootDir>/src/app/main.tsx'`, `'<rootDir>/src/index.tsx'`, and `.*\.d\.ts$` as the only exclusions. No other file is excluded from coverage, matching Requirement 3.4 and Requirement 3.5. The API test suite includes `health.controller.spec.ts` and `origin-guard.middleware.spec.ts` (or an equivalent `app.e2e-spec.ts`) driven by `supertest` against the compiled Nest application (Requirement 3.7). The web test suite includes a render test for the placeholder page and a test that dispatches an action against the configured store (Requirement 3.8).

## ESLint, Prettier, and dependency-cruiser

- `api/eslint.config.mjs` and `web/eslint.config.mjs` use the flat config format (ESLint v10 removed `.eslintrc`): `@eslint/js` recommended, `typescript-eslint` v8 recommended through `tseslint.config(...)`, and `eslint-plugin-prettier/recommended` (which also applies `eslint-config-prettier`), so Prettier owns formatting, ESLint owns correctness rules, and a formatting violation is reported as a lint error (Requirement 2.1, Requirement 2.3). The web config adds `eslint-plugin-react-hooks`.
- `api/eslint.config.mjs` adds a config object with `files: ['src/domain/**/*.ts']` that sets `@typescript-eslint/no-explicit-any: 'error'` (Requirement 2.4).
- `api/.dependency-cruiser.cjs` defines the Dependency_Rule:

```javascript
module.exports = {
  forbidden: [
    {
      name: 'domain-no-framework-imports',
      severity: 'error',
      from: { path: '^src/domain' },
      // Matches both installed packages (resolved path under node_modules/) and packages that are
      // not installed (unresolved, where dependency-cruiser reports the bare module name).
      to: { path: '(^|node_modules/)(@nestjs/|@aws-sdk/|express($|/)|axios($|/)|node-fetch($|/))' },
    },
    {
      name: 'domain-no-outer-layers',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/(application|infrastructure)' },
    },
  ],
  options: { tsPreCompilationDeps: true },
};
```

The `to.path` pattern matches by module name as well as by `node_modules/` path, so the rule also fires when the forbidden package is not installed (for example in fixture tests that run before `npm install` of that package). Exposed as `"depcruise": "depcruise src --config .dependency-cruiser.cjs"` in `api/package.json` so the CI pipeline can invoke it (Requirement 4.5).

## CI Pipeline (`.github/workflows/ci.yml`)

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [master]
permissions:
  contents: read
jobs:
  api:
    runs-on: ubuntu-latest
    strategy:
      matrix: { node-version: [22] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm', cache-dependency-path: api/package-lock.json }
      - run: npm ci
        working-directory: api
      - run: npm run lint
        working-directory: api
      - run: npx tsc --noEmit
        working-directory: api
      - run: npm run depcruise
        working-directory: api
      - run: npm test -- --coverage
        working-directory: api
      - run: npm run build
        working-directory: api
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm', cache-dependency-path: web/package-lock.json }
      - run: npm ci
        working-directory: web
      - run: npm run lint
        working-directory: web
      - run: npx tsc --noEmit
        working-directory: web
      - run: npm test -- --coverage
        working-directory: web
      - run: npm run build
        working-directory: web
  repo-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: gitleaks
        # Pinned release binary run directly, so the job needs no token or secret expression.
        run: |
          curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | tar -xz gitleaks
          ./gitleaks detect --source . --redact --verbose
        env:
          GITLEAKS_VERSION: '8.18.4'
      - name: forbidden words check
        run: |
          if [ -f .kiro/private/forbidden-words.txt ]; then
            bash scripts/check-forbidden-words.sh
          else
            echo "::notice::forbidden-words file is git-ignored and not present on this runner; the local git hooks enforce this check"
          fi
```

- Each job runs on Node.js 22 and caches npm dependencies through `actions/setup-node`'s built-in cache (Requirement 5.2, Requirement 5.7).
- The workflow-level `permissions: contents: read` applies to every job (Requirement 5.8).
- No step references a secret or an AWS credential; the workflow has no `secrets.` expression, no `aws-actions/*` action, no `id-token` permission, no `terraform` command and no `AWS_` variable (Requirement 5.9). gitleaks runs as a pinned release binary so no token is needed.
- `ci.yml` triggers on `pull_request` and on `push` to `master`; a pull request never starts `deploy.yml`, which has no `pull_request` trigger (Requirement 5.10).
- The `repo-checks` job runs gitleaks over full history (`fetch-depth: 0`) and the forbidden-words script, which reads `.kiro/private/forbidden-words.txt`. That file is git-ignored, so on GitHub-hosted runners it is absent and the step prints a notice and exits 0; the enforcing guard is the local `pre-commit` and `commit-msg` hooks, enabled by the Developer with `git config core.hooksPath .githooks` (Requirement 5.4, Requirement 5.5, Requirement 18.6). A failing step in any job fails that job, which fails the overall required check (Requirement 5.6).

## Remote State and Bootstrap Module

### Remote state for `infra/`

`infra/providers.tf` declares a partial S3 backend. Bucket, key and region are not hardcoded; the workflow passes them with `-backend-config` from the Deploy_Variables (Requirement 12.2, 21.6).

```hcl
terraform {
  backend "s3" {
    use_lockfile = true   # S3 native locking, no DynamoDB lock table
    encrypt      = true
  }
}
```

```bash
terraform init \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="key=card-checkout-store/infra.tfstate" \
  -backend-config="region=${AWS_REGION}"
```

### `infra/bootstrap` (one-time, local state)

The module has no `backend` block, so its state is a local `terraform.tfstate` that `.gitignore` already excludes (`*.tfstate`, `*.tfstate.*`, `.terraform/`). The Developer keeps that file outside git (Requirement 19.1, 19.7, 24.8). It contains no secret values and no access keys (Requirement 19.9).

| Resource | Settings |
|---|---|
| `aws_s3_bucket.state` | name from `var.state_bucket_name`; `force_destroy = false` |
| `aws_s3_bucket_versioning.state` | `Enabled` |
| `aws_s3_bucket_server_side_encryption_configuration.state` | `AES256` |
| `aws_s3_bucket_public_access_block.state` | all four settings `true` |
| `local.github_oidc_provider_arn` (no resource, no data source) | `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`; the provider was created by the Developer outside Terraform (audience `sts.amazonaws.com`) |
| `aws_iam_role.deploy` | trust policy below, `max_session_duration = 3600` |
| `aws_iam_role_policy.deploy` | least-privilege policy below |

Variables: `github_owner`, `github_owner_id`, `github_repo`, `github_repo_id`, `state_bucket_name`, `project_name`. Outputs: `deploy_role_arn`, `state_bucket_name` (Requirement 19.5, 19.6).

### Deploy_Role trust policy

```hcl
data "aws_iam_policy_document" "deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:ref:refs/heads/master",
        "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:environment:production",
      ]
    }
  }
}
```

The repository value in the Developer's setup is `salgado-2022@109880782/card-checkout-store@1473672119` (owner id and repository id from `gh api`). GitHub sends these immutable ids in the `sub` claim, so a repository deleted and re-created under the same name does not match. The `sub` condition uses `StringEquals` with exactly the two values, never `StringLike` or a wildcard (Requirement 20.1 to 20.3). The `plan` job (no environment) presents the `ref:refs/heads/master` subject; the jobs that declare `environment: production` present the `environment:production` subject.

### Deploy_Role permission policy

One statement per service, each scoped to resources named with the `project_name` prefix (Requirement 20.4 to 20.8):

| Service | Actions (grouped, no `*:*`) | Resources |
|---|---|---|
| S3 state | `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` (lock file), `s3:ListBucket`, `s3:GetBucketVersioning` | State_Bucket and `State_Bucket/*` only |
| S3 web | bucket management and object read/write actions that the `aws_s3_bucket*` resources and `s3 sync` use | `arn:aws:s3:::<project_name>-web*` and its objects |
| CloudFront | distribution, OAC, response headers policy and function management, `CreateInvalidation` | `*` (CloudFront does not support name-scoped ARNs for creation) |
| Lambda | function, Function URL, permission management, `UpdateFunctionCode`, `GetFunction` | `arn:aws:lambda:us-east-2:<account>:function:<project_name>-*` |
| DynamoDB | table, GSI, TTL and tagging management | `arn:aws:dynamodb:us-east-2:<account>:table/<project_name>-*` and `/index/*` |
| SSM | `PutParameter`, `GetParameter(s)`, `DeleteParameter`, `AddTagsToResource`, `ListTagsForResource`; `DescribeParameters` on `*` | `arn:aws:ssm:us-east-2:<account>:parameter/<project_name>/origin/*` only; no action on `/<project_name>/payment/*` (Requirement 20.5a) |
| IAM | `GetRole`, `UpdateRole`, `UpdateAssumeRolePolicy`, `DeleteRole`, `TagRole`, `UntagRole`, `GetRolePolicy`, `ListRolePolicies`, `ListAttachedRolePolicies`, `ListInstanceProfilesForRole` on the Lambda role; `CreateRole`, `PutRolePolicy`, `DeleteRolePolicy`, `PutRolePermissionsBoundary` only when `iam:PermissionsBoundary` equals the `<project_name>-lambda-boundary` policy created by `infra/bootstrap`; `iam:DeleteRolePermissionsBoundary` is denied on `role/*`; `iam:PassRole` with condition `iam:PassedToService = lambda.amazonaws.com` | `arn:aws:iam::<account>:role/<project_name>-lambda-exec` only. No `AttachRolePolicy` or `DetachRolePolicy`, and no action on `policy/*` |
| CloudWatch Logs | log group create/delete/describe, `PutRetentionPolicy`, tagging | `arn:aws:logs:us-east-2:<account>:log-group:/aws/lambda/<project_name>-*` (and `logs:DescribeLogGroups` on `*`) |
| Budgets | `budgets:ViewBudget`, `budgets:ModifyBudget`, `budgets:TagResource` | the project budget ARN |

There is no `iam:*`, no `iam:CreateUser`, no `iam:CreateAccessKey`, no `*:*`, and no permission on the OIDC provider or on the Deploy_Role itself. The Bootstrap_Module resources are reachable only through the State_Bucket statement.

## Deploy Pipeline (`.github/workflows/deploy.yml`)

Triggers are `push` to `master` and `workflow_dispatch`. There is no `pull_request` trigger (Requirement 5.10, 21.1, 21.2). Workflow-level permissions are `contents: read`; jobs that call AWS add `id-token: write`. No job has any other permission (Requirement 21.3).

```yaml
name: deploy
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [master]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: deploy-production
  cancel-in-progress: false
env:
  DEPLOY_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}   # deploy exactly the commit CI validated
  AWS_REGION: ${{ vars.AWS_REGION }}
  TF_STATE_BUCKET: ${{ vars.TF_STATE_BUCKET }}
  TF_VAR_budget_notification_email: ${{ vars.BUDGET_NOTIFICATION_EMAIL }}
  TF_VAR_payment_api_url: ${{ vars.PAYMENT_API_URL }}
  TF_VAR_payment_public_key: ${{ vars.PAYMENT_PUBLIC_KEY }}   # public value; feeds the Lambda PAYMENT_PUBLIC_KEY variable
jobs:
  plan:
    # Only after a green CI run of a push to master in this repository, or a manual dispatch.
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
       github.event.workflow_run.event == 'push' &&
       github.event.workflow_run.head_repository.full_name == github.repository)
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    defaults: { run: { working-directory: infra } }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ env.DEPLOY_SHA }}' }
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-arn: '${{ vars.AWS_ROLE_ARN }}', aws-region: '${{ vars.AWS_REGION }}', role-duration-seconds: 3600 }
      - uses: hashicorp/setup-terraform@v3
      - run: terraform fmt -check -recursive
      - run: >
          terraform init
          -backend-config="bucket=$TF_STATE_BUCKET"
          -backend-config="key=card-checkout-store/infra.tfstate"
          -backend-config="region=$AWS_REGION"
      - run: terraform validate
      - run: terraform plan -input=false -out=tfplan
      - name: Plan summary
        run: |
          { echo '```'; terraform show -no-color tfplan; echo '```'; } >> "$GITHUB_STEP_SUMMARY"

  apply:
    needs: plan
    runs-on: ubuntu-latest
    environment: production            # required reviewer approves here
    permissions: { id-token: write, contents: read }
    defaults: { run: { working-directory: infra } }
    outputs:
      lambda_function_name: ${{ steps.out.outputs.lambda_function_name }}
      web_bucket_name: ${{ steps.out.outputs.web_bucket_name }}
      distribution_id: ${{ steps.out.outputs.distribution_id }}
      distribution_domain: ${{ steps.out.outputs.distribution_domain }}
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ env.DEPLOY_SHA }}' }
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-arn: '${{ vars.AWS_ROLE_ARN }}', aws-region: '${{ vars.AWS_REGION }}', role-duration-seconds: 3600 }
      - uses: hashicorp/setup-terraform@v3
      - run: >
          terraform init
          -backend-config="bucket=$TF_STATE_BUCKET"
          -backend-config="key=card-checkout-store/infra.tfstate"
          -backend-config="region=$AWS_REGION"
      - run: terraform plan -input=false -out=tfplan   # re-plan inside the approved job; plan files never leave the runner
      - run: terraform apply -input=false tfplan
      - id: out
        run: |
          echo "lambda_function_name=$(terraform output -raw lambda_function_name)" >> "$GITHUB_OUTPUT"
          echo "web_bucket_name=$(terraform output -raw web_bucket_name)" >> "$GITHUB_OUTPUT"
          echo "distribution_id=$(terraform output -raw distribution_id)" >> "$GITHUB_OUTPUT"
          echo "distribution_domain=$(terraform output -raw distribution_domain_name)" >> "$GITHUB_OUTPUT"

  deploy-api:
    needs: apply
    runs-on: ubuntu-latest
    environment: production
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ env.DEPLOY_SHA }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm, cache-dependency-path: api/package-lock.json }
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-arn: '${{ vars.AWS_ROLE_ARN }}', aws-region: '${{ vars.AWS_REGION }}', role-duration-seconds: 3600 }
      - run: npm ci && npm run build && (cd dist && zip -qr ../lambda.zip .)
        working-directory: api
      - run: |
          aws lambda update-function-code --function-name "${{ needs.apply.outputs.lambda_function_name }}" --zip-file fileb://api/lambda.zip
          aws lambda wait function-updated --function-name "${{ needs.apply.outputs.lambda_function_name }}"

  deploy-web:
    needs: [apply, deploy-api]
    runs-on: ubuntu-latest
    environment: production
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ env.DEPLOY_SHA }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm, cache-dependency-path: web/package-lock.json }
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-arn: '${{ vars.AWS_ROLE_ARN }}', aws-region: '${{ vars.AWS_REGION }}', role-duration-seconds: 3600 }
      - run: npm ci && npm run build
        working-directory: web
        env:
          VITE_API_BASE: /api/v1
          VITE_PAYMENT_API_URL: ${{ vars.PAYMENT_API_URL }}
          VITE_PAYMENT_PUBLIC_KEY: ${{ vars.PAYMENT_PUBLIC_KEY }}
      - run: |
          BUCKET="${{ needs.apply.outputs.web_bucket_name }}"
          aws s3 sync web/dist "s3://$BUCKET" --delete --exclude index.html \
            --cache-control "public, max-age=31536000, immutable"
          aws s3 cp web/dist/index.html "s3://$BUCKET/index.html" --cache-control "no-cache"
          aws cloudfront create-invalidation --distribution-id "${{ needs.apply.outputs.distribution_id }}" --paths "/*"

  smoke-test:
    needs: [apply, deploy-web]
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ env.DEPLOY_SHA }}' }
      - run: bash scripts/smoke-test.sh "https://${{ needs.apply.outputs.distribution_domain }}"
```

Design points:

- **Order and gating.** `plan` -> `apply` -> `deploy-api` -> `deploy-web` -> `smoke-test`, enforced with `needs`. `apply`, `deploy-api` and `deploy-web` declare `environment: production`, so no `terraform apply`, Lambda update or S3 upload starts before the reviewer approves; a rejection ends the run with no AWS change (Requirement 22.1 to 22.5). The plan is readable in the `plan` job summary before the gate.
- **Trigger.** `workflow_run` on `ci` (type `completed`, branch `master`) plus `workflow_dispatch`. The `plan` job's `if` requires a successful CI run of a `push` event from this same repository, so pull requests and forks never deploy, and every checkout uses `DEPLOY_SHA` (the commit CI validated). A `workflow_run` run executes in the default-branch context, so its OIDC `sub` is `ref:refs/heads/master`, which the trust policy already admits.
- **Plan handling.** The `plan` job publishes the plan text in the job summary (`terraform show` masks sensitive values) so the reviewer reads it before approving. Plan files are never uploaded as artifacts: in a public repository artifacts are downloadable, and plan files hold sensitive values such as the Origin_Verify_Secret in plain text (Requirement 21.15). After approval, `apply` runs `terraform plan -out=tfplan` and `terraform apply tfplan` in the same job; the `concurrency` group guarantees no other run changes the state in between.
- **Concurrency.** One group, `cancel-in-progress: false`, so a running apply is never cancelled (Requirement 21.4).
- **Credentials.** Only `aws-actions/configure-aws-credentials` with `role-arn` (OIDC). No `aws-access-key-id`, no `AWS_SECRET_ACCESS_KEY`, no `secrets.` expression. Values come from `vars.*` (Requirement 20.10, 21.5, 21.13).
- **Not printed.** No step echoes SSM values or the origin secret; `terraform show` masks sensitive values; outputs read by the workflow are non-sensitive names and ids (Requirement 21.14).
- **Fail fast.** Default step behavior stops a job on a non-zero exit code; downstream jobs are skipped through `needs` (Requirement 21.12).
- **No destroy.** The workflow files contain no `terraform destroy` or `-destroy` flag.
- **Initial Lambda code.** The Terraform `aws_lambda_function` is created from a small placeholder zip (`archive_file`) and uses `lifecycle { ignore_changes = [filename, source_code_hash] }`, so `deploy-api` owns the real code and later applies do not revert it.

### Smoke test (`scripts/smoke-test.sh`)

A bash script that takes the base URL. For each of `/` and `/api/v1/health` it runs `curl -sS -D headers.txt -o body.txt` with no `X-Origin-Verify` header, and up to 5 attempts with `sleep 5` between attempts. A check passes when the status is 200, the six headers are present (`strict-transport-security`, `content-security-policy`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, `permissions-policy`, case-insensitive), and, for health, the body equals `{"status":"ok"}`. On failure after the last attempt, it prints the failed check name (for example `FAILED: GET /api/v1/health missing header x-frame-options`) and exits non-zero (Requirement 23.1 to 23.6). The script is also what `docs/deployment.md` tells the Developer to run manually (Requirement 24.9).

### Deploy_Variables

| Variable | Scope | Source |
|---|---|---|
| `AWS_ROLE_ARN` | repository (the `plan` job has no environment and must read it) | Bootstrap output `deploy_role_arn` |
| `AWS_REGION` | repository | `us-east-2` |
| `TF_STATE_BUCKET` | repository | Bootstrap output `state_bucket_name` |
| `BUDGET_NOTIFICATION_EMAIL` | repository | Developer email |
| `PAYMENT_API_URL` | repository | payment sandbox base URL (public value) |
| `PAYMENT_PUBLIC_KEY` | repository | payment public key (public value, bundled in the web build) |

Web bucket name, Distribution id, Lambda name and Distribution domain are not variables: `apply` reads them from Terraform outputs and passes them to later jobs as job outputs (Requirement 21.11). All are GitHub variables, never secrets. The three payment secrets and the origin secret never pass through GitHub.

### Documentation (`docs/deployment.md`)

Ordered sections, in English (Requirement 24):

1. Prerequisites (AWS account, Terraform, AWS CLI, GitHub repository `salgado-2022/card-checkout-store`).
2. Run the Bootstrap_Module: `terraform init`, `terraform plan`, `terraform apply` in `infra/bootstrap`; read outputs `deploy_role_arn` and `state_bucket_name`; keep the local state file outside git.
3. Create the `production` environment with at least one required reviewer.
4. Load the Deploy_Variables table above.
5. Trigger the first run (`workflow_dispatch` or push to `master`), read the plan summary, approve.
6. Before step 5 (first run): create the three Payment_Secret_Parameters with `aws ssm put-parameter --name /<project_name>/payment/<name> --type SecureString --value file://<local-file>` (reading the value from a local file keeps it out of shell history); to change one later, add `--overwrite` and re-run the workflow so a new Lambda cold start reads it.
7. Run the smoke test commands manually.
8. Statement that real payment secrets are never stored in GitHub, Terraform files or the repository.

## Data Models

This spec does not introduce the five business DynamoDB tables' read/write logic (no use cases yet); it only provisions them in Terraform per the capacity table above, matching the schema fixed in the source data model section (`products`, `customers` with GSI `email`, `transactions` with GSI `reference`, `deliveries`, `idempotency_keys` with TTL `expiresAt`). No application code in this spec reads or writes these tables.

`AppConfig` (above) is the only new data model introduced by this spec, representing validated runtime configuration.

## Error Handling

- **Configuration errors**: `loadConfig()` returns `Result<AppConfig, ConfigError>`. `ConfigError.variableName` names the missing/invalid variable; no value is ever included. `main.ts`/`lambda.ts` is the single boundary that unwraps the `Result` and throws, stopping startup (Requirement 7.2, Requirement 7.4).
- **Origin guard errors**: modeled as a direct 403 response (not a thrown exception) to keep the middleware fast and avoid passing through the generic exception filter; the shape still matches the fixed error envelope.
- **HTTP errors (general)**: the `ResultExceptionFilter` catches any unhandled exception and any domain/application error surfaced through Nest's exception mechanism, and always responds with `{ statusCode, code, message, details }`, never a stack trace (Requirement 8.6, Requirement 10.6).
- **SSM read failure at cold start**: `OriginSecretProvider` propagates the failure so that Lambda initialization fails; the resulting CloudWatch log entry names `ORIGIN_VERIFY_SECRET_PARAM` and omits any value (Requirement 9.7).
- **Terraform validation errors**: `terraform plan`/`validate` fails with a message naming `budget_notification_email` when that variable is not supplied, because the variable has no default (Requirement 16.4).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Origin guard rejects every request without a valid secret

For any HTTP request to the API (any method, any route, including `GET /api/v1/health`), if the `X-Origin-Verify` header is absent or its value differs from the configured Origin_Verify_Secret, the API responds with status 403 and the body `{ "statusCode": 403, "code": "FORBIDDEN_ORIGIN", "message": <text>, "details": [] }`, containing neither the expected secret nor the received header value.

**Validates: Requirements 9.1, 9.2, 9.5, 9.6**

### Property 2: Origin guard passes through on a valid secret

For any HTTP request to the API whose `X-Origin-Verify` header value equals the configured Origin_Verify_Secret, the request reaches its route handler and is not short-circuited by the guard.

**Validates: Requirements 9.3**

### Property 3: Health endpoint responds without side-effecting calls

For any valid `GET /api/v1/health` request (carrying a correct `X-Origin-Verify` header), the API responds with status 200 and a JSON body `{ "status": "ok" }`, and no call to DynamoDB, SSM, or the payment gateway occurs during the handling of that request.

**Validates: Requirements 8.1, 8.2**

### Property 4: Request-Id propagation

For any HTTP request, if the request carries an `X-Request-Id` header, the response carries the same value under `X-Request-Id`; if the request carries no such header, the response carries a generated, non-empty `X-Request-Id` value.

**Validates: Requirements 8.4**

### Property 5: Error responses never leak internals

For any error condition handled by the Result → HTTP mapping filter (configuration errors excluded, since those stop the process before any HTTP response exists), the resulting response body contains no stack trace, no environment variable value, and no secret value.

**Validates: Requirements 8.6, 10.6, 17.2**

### Property 6: Missing or invalid configuration fails startup without leaking values

For any environment in which at least one required variable (from the set in Requirement 7.1) is missing or has an invalid format, `loadConfig()` returns `Err` naming that variable, and no log line or thrown error message produced during startup contains the value of any environment variable.

**Validates: Requirements 7.2**

### Property 7: Fee defaults apply only when unset

For any environment where `BASE_FEE_IN_CENTS` is unset, `loadConfig()` resolves it to `300000`; for any environment where `DELIVERY_FEE_IN_CENTS` is unset, `loadConfig()` resolves it to `800000`; for any environment where either variable is set to a valid integer string, `loadConfig()` resolves it to that integer instead of the default.

**Validates: Requirements 7.3**

### Property 8: Dependency rule rejects forbidden domain imports

For any TypeScript file under `api/src/domain`, if it imports from `@nestjs/*`, `@aws-sdk/*`, `express`, `axios`, `node-fetch`, `api/src/application`, or `api/src/infrastructure`, whether or not the imported package is installed, the dependency-cruiser check reports an error for that file; for any file under `api/src/domain` that imports none of these, the check reports no error for that file.

**Validates: Requirements 4.2, 4.3**

### Property 9: Coverage gate fails below threshold

For any coverage run in `api/` or `web/`, if any of the four metrics (statements, branches, functions, lines) is below 80, `npm test -- --coverage` exits with a non-zero code; if all four metrics are at or above 80, it exits with code 0 (assuming no other test failure).

**Validates: Requirements 3.3**

### Property 10: SPA rewrite applies only to extension-less, non-API paths

For any request URI, if the path has no file extension and does not start with `/api/`, the SPA_Rewrite_Function rewrites the URI to `/index.html`; for any request URI that has a file extension, or that starts with `/api/`, the function leaves the URI unchanged.

**Validates: Requirements 14.1, 14.2**

### Property 11: Web production bundle contains no secret material

For any completed production build of the Web_App, the emitted bundle contains no occurrence of the string `prv_` and no value of any SSM parameter, and every environment variable name embedded in the bundle starts with `VITE_`.

**Validates: Requirements 6.4, 6.7**

### Property 12: Deploy role trust policy admits only this repository's master branch and production environment

For any GitHub OIDC token claim set (any `aud`, any `sub` such as another repository, another branch, a pull request ref, another environment, a prefix or wildcard variant), the Deploy_Role trust policy admits the token if and only if `aud` equals `sts.amazonaws.com` and `sub` equals `repo:salgado-2022@109880782/card-checkout-store@1473672119:ref:refs/heads/master` or `repo:salgado-2022@109880782/card-checkout-store@1473672119:environment:production`. Subjects without the ids, or with any other owner or repository id, are rejected. The only allowed action is `sts:AssumeRoleWithWebIdentity` and the only principal is the GitHub_OIDC_Provider.

**Validates: Requirements 20.1, 20.2, 20.3**

### Property 13: Workflows contain no destroy and no long-lived AWS credentials

For any workflow file under `.github/workflows/` (and any script it calls), the file contains no `terraform destroy` command, no `-destroy` plan flag, no `aws-access-key-id` input, no `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` reference and no string matching an access key id pattern (`AKIA[0-9A-Z]{16}`).

**Validates: Requirements 15.6, 20.10, 21.5, 21.13**

### Property 14: `ci.yml` has no AWS, secret or deploy references

For any content of `ci.yml`, it contains no `secrets.` expression, no `aws-actions/` action, no `id-token` permission, no `AWS_` variable, no `terraform` command and no `environment:` key, and its only permission is `contents: read`.

**Validates: Requirements 5.8, 5.9, 5.10**

### Property 15: `deploy.yml` job order, gating and permissions

For any job in `deploy.yml`, the job permissions are a subset of `{ id-token: write, contents: read }`; every job that calls AWS has `id-token: write` and `contents: read`; the `needs` graph is the chain `plan` -> `apply` -> `deploy-api` -> `deploy-web` -> `smoke-test`; `apply`, `deploy-api` and `deploy-web` declare `environment: production`; `plan` declares no environment and `terraform apply` appears only in `apply`, preceded in the same job by `terraform plan -out=tfplan` and with `tfplan` as its argument; no step uses `actions/upload-artifact` or `actions/download-artifact`; the `concurrency` group sets `cancel-in-progress: false`; the triggers are exactly `workflow_run` (workflow `ci`, type `completed`, branch `master`) and `workflow_dispatch`; and the `plan` job's `if` requires a successful `push` run from the same repository. Within `plan`, the steps run in the order `fmt -check`, `init`, `validate`, `plan`.

**Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.6, 21.8, 21.15, 22.1, 22.3, 22.4**

### Property 16: Smoke test passes if and only if status, headers and body are all correct

For any HTTP response served to `scripts/smoke-test.sh` (any status code, any subset of the six security headers, any health body), the check passes if and only if the status is 200, all six headers are present and, for `/api/v1/health`, the body is `{"status":"ok"}`. A failing check exits non-zero and prints the name of the failed check. For any run, the requests carry no `X-Origin-Verify` header and a persistently failing request is attempted exactly 5 times.

**Validates: Requirements 23.2, 23.3, 23.4, 23.5, 23.6**

## Testing Strategy

**Unit tests** (examples and edge cases, kept small since properties cover the input space):
- `env.config.spec.ts`: one example per required variable showing a missing-variable `Err`; one example confirming both fee defaults; one example confirming an explicit fee value overrides the default.
- `health.controller.spec.ts` + a supertest e2e test: `GET /api/v1/health` with a valid header returns 200 and `{"status":"ok"}`; without the header returns 403.
- `result-exception.filter.spec.ts`: one example per mapped error code confirming the fixed envelope shape and absence of a `stack` field.
- Bundled boot test (Requirement 10.1a): invoke `dist/lambda.js` with a Function URL event for health, as described in Lambda bundle.
- Web: render test for the placeholder page (title text present, in Spanish) and a store test (dispatch + selector round trip on the configured store).
- Infra and workflows, static checks (Jest in `api/test/infra/`, reading the repo files; no AWS calls and no Terraform binary needed): `infra/bootstrap` has versioning, SSE, four public access block flags, the OIDC provider URL and client id, `max_session_duration = 3600`, no `iam:*`, no `*:*`, no `iam:CreateAccessKey`/`iam:CreateUser`, and IAM resources scoped to the Lambda role prefix; `infra/providers.tf` has `backend "s3"` with `use_lockfile = true`, no `bucket =` literal and no DynamoDB lock table; `infra/ssm.tf` has `random_password` for the origin secret and `infra/` has no `aws_ssm_parameter` resource or data source for the payment parameters; `lambda.tf` has `nodejs22.x` and the two `aws_lambda_permission` resources; `.github/pull_request_template.md` exists and `.github/workflows/` has none; `deploy.yml` contains the cache-control values (`max-age=31536000, immutable` for assets, `no-cache` for `index.html`) and a `create-invalidation` step; `docs/deployment.md` has the required headings and every Deploy_Variable name.
- `terraform fmt -check` and `terraform validate` for `infra/` and `infra/bootstrap` run in the `plan` job of `deploy.yml` and, if the Developer wants them earlier, locally; `ci.yml` never runs Terraform because it has no AWS access. They are documented in `infra/README.md`.

**Property-based tests** (Jest + `fast-check`, minimum 100 iterations each, tagged `Feature: platform-foundation, Property N: <text>`):
- Property 1 and Property 2: generate random header presence/absence and random string values for `X-Origin-Verify`, asserting the 403/pass-through split and the absence of secret values in rejection bodies.
- Property 4: generate random `X-Request-Id` values (including absent) and assert propagation vs. generation.
- Property 5: generate random thrown errors/known domain error types and assert the response body never contains a stack-trace-shaped string or any configured secret value.
- Property 6 and Property 7: generate random subsets of required variables to omit/corrupt, and random valid/invalid fee strings, asserting `loadConfig()` behavior and log-line content.
- Property 9: this property is validated by a scripted Jest run with synthetic low-coverage fixtures rather than fuzzing arbitrary inputs, since "coverage percentage" is not itself a random input domain; treat as an integration-style check of the Jest config, run once, not as a 100-iteration property.
- Property 10: generate random path strings (with/without extensions, with/without `/api/` prefix) and assert the CloudFront Function's rewrite logic in isolation (unit-testing the JS function body directly in Jest, outside of CloudFront).
- Property 12: a pure Jest helper parses the trust policy conditions from `infra/bootstrap/*.tf` into `{ actions, aud, subs }` and evaluates a claim set against it; `fast-check` generates `sub` and `aud` values (other owners and repos, other branches, `pull_request` refs, other environments, prefix and wildcard variants) and asserts admission only for the two exact subjects with the exact audience. The static structure (single action, `StringEquals`, no wildcard) is asserted once as an example.
- Property 13 and Property 14: a scanner function takes workflow text and returns the list of violations. `fast-check` injects forbidden tokens into random YAML-like text and asserts the scanner detects them, and asserts that clean text passes. Then the scanner runs on every real file in `.github/workflows/` and on `scripts/`.
- Property 15: a Jest test parses `deploy.yml` with a YAML parser and asserts the invariants over all jobs (iterating the parsed `jobs` map). It is an example-style test over one fixed file, with a small mutation helper that checks the assertions fail for variants (a job with extra permissions, a missing `environment`, `cancel-in-progress: true`, apply in `plan`).
- Property 16: Jest starts a local `http` server, runs `scripts/smoke-test.sh` through `child_process` with the base URL and a retry delay override of 0 seconds, and uses `fast-check` to generate status codes, subsets of the six headers and health bodies. It asserts the exit code, the printed failed-check name, that the server never received `x-origin-verify`, and that a persistently failing path receives exactly 5 requests.
- Property 3, Property 8, Property 11 are validated as integration-style checks (mock DynamoDB/SSM/payment clients and assert zero calls; run dependency-cruiser against fixture files, including fixtures that import packages that are not installed; grep the built bundle) rather than property-based tests, because their inputs are fixed configurations, not large input domains — each still uses a handful of representative fixtures rather than a single hard-coded case.
