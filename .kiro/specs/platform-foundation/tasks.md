# Implementation Plan: Platform Foundation

## Overview

The work is split into two suggested branches, each one pull request:

- `chore/repo-setup`: epics 1–6. Repository baseline, API and web tooling (ESLint, Prettier, Jest with an 80% threshold, dependency-cruiser), web skeleton, CI pipeline (`ci.yml`, which never touches AWS or secrets).
- `feat/infra-base`: epics 7–14. API runtime (config, origin guard, health, Lambda bundle), Terraform base infrastructure with a partial S3 backend, `infra/bootstrap` (state bucket, GitHub OIDC provider, least-privilege deploy role), `deploy.yml` (plan -> apply -> deploy-api -> deploy-web -> smoke-test), `scripts/smoke-test.sh`, docs, and the Developer-only manual section.

Deployment is done by `deploy.yml` (started by a green `ci.yml` on `master`) after the Developer runs `infra/bootstrap` once, creates the three payment secrets in SSM with the AWS CLI, and approves the run on the GitHub Environment `production`. There are no manual `terraform apply`, S3 upload or Lambda zip tasks any more.

Conventions for every task:

- Language is TypeScript (`strict: true`), Node.js 22, tests with Jest only (`ts-jest` or `@swc/jest`). Never Vitest or Mocha.
- Each sub-task is sized for about 1 hour or less and includes its own Jest tests in the same sub-task.
- Property-based tests use `fast-check`, at least 100 runs, tagged `Feature: platform-foundation, Property N: <text>`.
- Use the generic word `payment` for the provider. No provider name anywhere (code, tests, comments, docs, commit text). Run `bash scripts/check-forbidden-words.sh` before handing work back.
- Agents never run `git commit`, `git push`, `terraform apply`, `terraform destroy`, or call the payment provider or AWS with real credentials. Tasks marked **[MANUAL — developer only]** are for the Developer. Agents must skip them.
- Agents may run only `terraform fmt`, `terraform init -backend=false` and `terraform validate` (no AWS calls, no plan, no apply). Local validation of `infra/` never uses the S3 backend.
- Infra and workflow tests are static: they read repository files as text or parse YAML, and need neither the Terraform binary nor AWS.
- Test sub-tasks are not marked optional because the 80% coverage gate is a never-cut item.

## Tasks

### Branch `chore/repo-setup`

- [x] 1. Repository baseline
  - [x] 1.1 Extend `.gitignore` and create the directory skeleton
    - Verify and extend `.gitignore` so it lists `.env`, `*.tfstate`, `*.tfstate.*`, `.terraform/`, `.kiro/private/`, `*.tfvars`, `tfplan`, `lambda.zip`, `node_modules/`, `dist/`, `build/`, `coverage/`.
    - Create the folders with a `.gitkeep`: `api/src/domain`, `api/src/application/ports`, `api/src/application/use-cases`, `api/src/infrastructure/{http,persistence,payment,config}`, `api/scripts`, `web/src/{app,shared}`, `web/src/features/{product,checkout,transaction}`, `infra`, `docs`, `.github/workflows`.
    - Verify with `git check-ignore` that the listed patterns are ignored, including `infra/bootstrap/terraform.tfstate`, `infra/bootstrap/terraform.tfstate.backup` and `infra/bootstrap/.terraform/`.
    - _Requirements: 1.1, 1.2, 1.4, 1.10, 12.2a, 19.7_
  - [x] 1.2 Create `.env.example`
    - List variable names only, no secret values: backend `PAYMENT_API_URL`, `PAYMENT_PUBLIC_KEY`, `PAYMENT_PRIVATE_KEY_PARAM`, `PAYMENT_INTEGRITY_SECRET_PARAM`, `PAYMENT_EVENTS_SECRET_PARAM`, `ORIGIN_VERIFY_SECRET_PARAM`, `BASE_FEE_IN_CENTS`, `DELIVERY_FEE_IN_CENTS`, the five DynamoDB table names; frontend `VITE_API_BASE`, `VITE_PAYMENT_API_URL`, `VITE_PAYMENT_PUBLIC_KEY`.
    - Non-secret defaults allowed: `BASE_FEE_IN_CENTS=300000`, `DELIVERY_FEE_IN_CENTS=800000`, `VITE_API_BASE=/api/v1`.
    - Jest test `api/test/tooling/env-example.spec.ts`: every variable name required by Requirement 6.3 is present, and no line assigns a value that looks like a secret (`prv_`, long random strings).
    - _Requirements: 1.9, 6.1, 6.3_
  - [x] 1.3 Create the root `README.md` stub and the pull request template
    - `README.md` in English: project purpose, repository layout, commands for lint, type check, tests with coverage and build.
    - `.github/pull_request_template.md` (GitHub reads it from `.github/`, never from `.github/workflows/`): asks for the user story id and evidence of the Quality_Gates.
    - Jest test `api/test/tooling/repo-docs.spec.ts`: `README.md` mentions the four commands; `.github/pull_request_template.md` exists and mentions the user story id and the quality gates; no `pull_request_template.md` exists under `.github/workflows/`.
    - _Requirements: 18.1, 18.2_

- [x] 2. API tooling scaffold (`api/`)
  - [x] 2.1 Create the API package, TypeScript config and Node pin
    - `api/package.json` with `engines.node >=22 <23`, scripts `lint`, `test`, `build`, `typecheck` (`tsc --noEmit`), `depcruise` placeholder to be completed in 2.5.
    - `api/tsconfig.json` with `strict: true`; `api/.nvmrc` with `22`.
    - Add a minimal `api/src/main.ts` and `api/src/lambda.ts` placeholders (`export {}`) so entry files exist; real code comes in 7.15.
    - Run `npx tsc --noEmit` and confirm exit code 0.
    - _Requirements: 1.3, 1.5, 1.6, 1.7, 1.8, 2.5_
  - [x] 2.2 Configure ESLint and Prettier for the API, with the domain `no-explicit-any` rule
    - `api/eslint.config.mjs` in flat config format (ESLint v10 no longer reads `.eslintrc*`; do not create one): `@eslint/js` recommended, `typescript-eslint` v8 recommended via `tseslint.config(...)`, and `eslint-plugin-prettier/recommended` so formatting violations are lint errors. A config object with `files: ['src/domain/**/*.ts']` sets `@typescript-eslint/no-explicit-any: 'error'`. Add `api/.prettierrc`.
    - Jest test `api/test/tooling/eslint-config.spec.ts` using the `ESLint` Node API with in-memory sources: (a) `any` in a `src/domain` path reports an error, (b) the same code outside domain does not report that rule, (c) a badly formatted snippet reports a Prettier error.
    - `npm run lint` must exit 0.
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x] 2.3 Configure Jest for the API with the 80% threshold
    - `api/jest.config.ts` with `ts-jest` (or `@swc/jest`), `coverageThreshold.global` = 80 for statements, branches, functions and lines, `collectCoverageFrom: ['<rootDir>/src/**/*.ts']` (untested files count as 0%), and `coveragePathIgnorePatterns` limited to `main.ts`, `lambda.ts`, `*.module.ts`, `*.d.ts`, `scripts/seed.ts`.
    - Add `api/scripts/seed.ts` stub (`export {}`).
    - Add `api/test/tooling/jest-config.spec.ts` that imports the config and asserts the threshold values, `collectCoverageFrom` and the exact exclusion list (no other exclusions).
    - Install `fast-check`, `supertest`, `@types/jest`, `@types/supertest`, `yaml`.
    - _Requirements: 3.1, 3.2, 3.2a, 3.4_
  - [x] 2.4 Test the API coverage gate (Property 9)
    - **Property 9: Coverage gate fails below threshold**
    - **Validates: Requirements 3.3**
    - Scripted integration-style Jest test (single run, not fuzzed): create a temporary fixture project that reuses the real `jest.config.ts` threshold block, with a source file whose tests cover less than 80%; run Jest through `child_process` and assert a non-zero exit code. Repeat with a fully covered fixture and assert exit code 0.
    - _Requirements: 3.3_
  - [x] 2.5 Add dependency-cruiser and the domain dependency rule (Property 8)
    - **Property 8: Dependency rule rejects forbidden domain imports**
    - **Validates: Requirements 4.2, 4.3**
    - `api/.dependency-cruiser.cjs` with rules `domain-no-framework-imports` and `domain-no-outer-layers`, as in the design: `from.path` is `^src/domain`; the first rule's `to.path` is `(^|node_modules/)(@nestjs/|@aws-sdk/|express($|/)|axios($|/)|node-fetch($|/))` so it matches both resolved packages and bare module names of packages that are not installed (also cover other HTTP libraries such as `got`, `undici`, `superagent`); the second rule's `to.path` is `^src/(application|infrastructure)`. Set `options.tsPreCompilationDeps: true` and `"depcruise": "depcruise src --config .dependency-cruiser.cjs"`.
    - Jest test `api/test/tooling/dependency-rule.spec.ts`: create temp fixtures under a `src/domain` tree, one per forbidden import (parameterized with `it.each`), where the forbidden packages are deliberately NOT installed in the fixture, expecting a non-zero exit; plus clean fixtures (including a relative import inside domain) expecting zero. Also run `npm run depcruise` on the real tree and expect exit 0.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 3. Web skeleton (`web/`)
  - [x] 3.1 Create the web package, Vite and TypeScript config
    - `web/package.json` with `engines.node >=22 <23`, scripts `lint`, `test`, `build` (`tsc --noEmit && vite build`), `typecheck`. Dependencies: React 18, Redux Toolkit, react-redux, Vite, `@vitejs/plugin-react`. No Next.js, Angular, Vue or UI kit.
    - `web/tsconfig.json` (`strict: true`), `web/vite.config.ts` (default hashed file names, no custom `define` of non-`VITE_` variables), `web/index.html`, `web/.nvmrc` with `22`, `web/src/vite-env.d.ts` declaring `VITE_API_BASE`, `VITE_PAYMENT_API_URL`, `VITE_PAYMENT_PUBLIC_KEY`.
    - Run `npx tsc --noEmit` and confirm exit code 0.
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.8, 11.1, 11.3, 11.6_
  - [x] 3.2 Configure ESLint and Prettier for the web
    - `web/eslint.config.mjs` in flat config format (no `.eslintrc*`): `@eslint/js` recommended, `typescript-eslint` v8 recommended, `eslint-plugin-react-hooks` and `eslint-plugin-prettier/recommended`; `web/.prettierrc`.
    - Jest test `web/src/tooling/eslint-config.test.ts` using the `ESLint` Node API: a badly formatted snippet reports an error.
    - `npm run lint` must exit 0.
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 3.3 Configure Jest for the web with the 80% threshold
    - `web/jest.config.ts` with `ts-jest` or `@swc/jest`, `jsdom` environment, React Testing Library and user-event setup (`@testing-library/jest-dom`), CSS Modules mapped with `identity-obj-proxy`, `coverageThreshold.global` = 80 for all four metrics, `collectCoverageFrom: ['<rootDir>/src/**/*.{ts,tsx}']`, `coveragePathIgnorePatterns` limited to `src/app/main.tsx`, `src/index.tsx`, `*.d.ts`.
    - Handle `import.meta.env` under Jest (for example a small `getEnv` wrapper in `shared/api` mocked in tests, or a transformer), documented in the config.
    - Test `web/src/tooling/jest-config.test.ts` asserts threshold values, `collectCoverageFrom` and the exact exclusion list.
    - _Requirements: 3.1, 3.2, 3.2a, 3.3, 3.5_
  - [x] 3.4 Implement the Redux store with tests
    - `web/src/app/store.ts` using `configureStore` with a placeholder `app` slice (for example `{ ready: boolean }`) and exported `RootState`, `AppDispatch`, typed hooks in `web/src/app/hooks.ts`.
    - `store.test.ts`: dispatch an action and read the state through a selector.
    - _Requirements: 11.1, 11.7, 3.8_
  - [x] 3.5 Implement the API client with tests
    - `web/src/shared/api/client.ts`: thin `fetch` wrapper that prefixes `VITE_API_BASE` (value `/api/v1`) and returns a typed `Result` (neverthrow) instead of throwing for HTTP failures.
    - `client.test.ts` with msw: success path builds the URL from the base, a 4xx response returns `Err` with the error body, a network failure returns `Err`.
    - _Requirements: 11.5_
  - [x] 3.6 Implement the placeholder page and entry point with tests
    - `web/src/app/App.tsx` plus `App.module.css`: one placeholder page with a visible Spanish title, flexbox/grid only, no fixed widths over the viewport, no horizontal overflow from 375 px.
    - `web/src/app/main.tsx` mounts `<Provider store>`; `index.html` references it.
    - `App.test.tsx` (React Testing Library): the Spanish title is rendered inside the store provider.
    - _Requirements: 11.2, 11.4, 11.7, 3.8_
  - [x] 3.7 Test that the web bundle contains no secret material (Property 11)
    - **Property 11: Web production bundle contains no secret material**
    - **Validates: Requirements 6.4, 6.7**
    - Integration-style Jest test `web/src/tooling/bundle.test.ts`: run `vite build` into a temp `outDir` with a fixture environment (`VITE_*` placeholders and a non-`VITE_` variable such as `PAYMENT_PRIVATE_KEY_PARAM=fixture-secret`), scan every emitted file for `prv_` and for the fixture secret values, and assert none appear. Also assert the emitted asset file names contain a content hash.
    - _Requirements: 6.4, 6.7, 11.3_

- [x] 4. Continuous integration and git hooks
  - [x] 4.1 Create the CI workflow
    - `.github/workflows/ci.yml` as in the design: triggers `pull_request` and `push` to `master`; `permissions: contents: read`; jobs `api` (install, lint, `npx tsc --noEmit`, `npm run depcruise`, `npm test -- --coverage`, build), `web` (install, lint, `npx tsc --noEmit`, `npm test -- --coverage`, build), `repo-checks` (checkout with `fetch-depth: 0`, gitleaks as a pinned release binary run directly with `--redact`, forbidden-words script). Node 22 with `actions/setup-node` npm cache. No secrets, no AWS credentials, no `id-token`, no `environment:`, no `terraform` command.
    - Make the forbidden-words step skip with a clear notice when `.kiro/private/forbidden-words.txt` is not present on the runner.
    - `package-lock.json` files are required for `npm ci` caching (the Developer commits them).
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 6.2, 6.6, 15.6_
  - [x] 4.2 Test the workflow file
    - Jest test `api/test/tooling/ci-workflow.spec.ts` (dev dependency `yaml`): parse `ci.yml` and assert triggers (`pull_request`, `push` to `master`), `permissions` equals `{ contents: read }`, Node 22 in every job, npm cache configured, each required step exists in `api` and `web`, the gitleaks step with `fetch-depth: 0`, and the forbidden-words step exists.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 5.8, 6.2, 6.6_
  - [x] 4.3 Test the existing git hooks
    - Jest test `api/test/tooling/githooks.spec.ts` using `child_process`: run `.githooks/commit-msg` against temp message files. Valid Conventional Commit messages (`feat(api): add health`, `chore: setup`) exit 0; invalid ones (`added stuff`, empty) exit non-zero.
    - Do not execute `git commit`. Read the hooks first; if they need changes to satisfy Requirement 18.3 or 18.4, make the minimal edit.
    - _Requirements: 18.3, 18.4, 18.5_
  - [x] 4.4 Test that `ci.yml` has no AWS, secrets or deploy references (Property 14)
    - **Property 14: `ci.yml` has no AWS, secret or deploy references**
    - **Validates: Requirements 5.8, 5.9, 5.10**
    - Create a reusable scanner helper `api/test/tooling/helpers/workflow-scanner.ts` that takes workflow text and returns violations for a given rule set (rule sets are reused by task 11.4). The `ci.yml` rule set forbids `secrets.`, `aws-actions/`, `id-token`, `AWS_`, `terraform` and an `environment:` key.
    - Test `api/test/tooling/ci-isolation.spec.ts`: `fast-check` injects each forbidden token into random YAML-like text and asserts the scanner flags it; clean text passes; then the scanner runs on the real `ci.yml` and reports zero violations. Also assert via YAML parse that the only permission is `contents: read` and that no `pull_request` trigger exists in `deploy.yml` when that file is present (skip this last assertion until task 11.2 creates it, using `fs.existsSync`).
    - _Requirements: 5.8, 5.9, 5.10_

- [x] 5. Checkpoint, `chore/repo-setup`
  - Run in `api/` and `web/`: `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (confirm all four metrics are at least 80 in each project), `npm run build`; run `npm run depcruise` in `api/`; run `bash scripts/check-forbidden-words.sh` and confirm it reports no findings.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 2.2, 2.5, 3.6, 4.4, 6.6_

- [ ] 6. **[MANUAL — developer only]** Commit and open the `chore/repo-setup` pull request
  - Create the branch `chore/repo-setup`, review the diff, commit in small Conventional Commits (for example `chore(repo): add gitignore and env example`, `chore(api): add lint and jest tooling`, `feat(web): add skeleton`, `ci: add quality gates workflow`), push, open the PR with the template, wait for green CI (gitleaks and forbidden words included), squash merge to `master`.
  - Before the first commit, run `git config core.hooksPath .githooks` so the `pre-commit` and `commit-msg` hooks run locally (the CI forbidden-words step is skipped on GitHub-hosted runners).
  - Agents must not run `git commit` or `git push`.
  - _Requirements: 18.5, 18.6_

### Branch `feat/infra-base`

- [ ] 7. API runtime: configuration, origin guard, health, Lambda bundle
  - [ ] 7.1 Implement `loadConfig()` returning a `Result`
    - Install `neverthrow` and `zod`. Create `api/src/infrastructure/config/env.schema.ts` and `env.config.ts` with `AppConfig`, `ConfigError` (`kind`, `variableName` only, never a value), required variables from Requirement 7.1 plus the five table names (`DYNAMODB_TABLE_PRODUCTS`, `DYNAMODB_TABLE_CUSTOMERS`, `DYNAMODB_TABLE_TRANSACTIONS`, `DYNAMODB_TABLE_DELIVERIES`, `DYNAMODB_TABLE_IDEMPOTENCY_KEYS`), and defaults `BASE_FEE_IN_CENTS=300000`, `DELIVERY_FEE_IN_CENTS=800000`. `loadConfig` never throws.
    - Example tests `env.config.spec.ts`: one missing-variable `Err` per required variable (`it.each`), both fee defaults, an explicit fee overriding the default, a non-numeric fee returning `INVALID_ENV_VAR`.
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [ ] 7.2 Property test for configuration failure (Property 6)
    - **Property 6: Missing or invalid configuration fails startup without leaking values**
    - **Validates: Requirements 7.2**
    - `fast-check`: generate random subsets of required variables to omit or corrupt with random secret-looking values; assert `loadConfig` returns `Err` naming a variable and that `JSON.stringify(error)` and the error message never contain any generated value.
    - _Requirements: 7.2_
  - [ ] 7.3 Property test for fee defaults (Property 7)
    - **Property 7: Fee defaults apply only when unset**
    - **Validates: Requirements 7.3**
    - `fast-check`: unset fee variables resolve to 300000 and 800000; any valid integer string resolves to that integer.
    - _Requirements: 7.3_
  - [ ] 7.4 Implement the constant-time comparison helper
    - `api/src/infrastructure/http/security/timing-safe-equal.ts`: hash both inputs (SHA-256) then `crypto.timingSafeEqual`, so different lengths do not throw.
    - Unit tests: equal strings, different strings, different lengths, empty strings, unicode.
    - _Requirements: 9.4_
  - [ ] 7.5 Implement `OriginSecretProvider`
    - Install `@aws-sdk/client-ssm` and `aws-sdk-client-mock`. `origin-secret.provider.ts` reads `ORIGIN_VERIFY_SECRET_PARAM` with `WithDecryption: true` once per container, caches the value at module scope, and returns a `ResultAsync` with an error that names the parameter and never the value.
    - Tests with `aws-sdk-client-mock`: first call hits SSM once, later calls reuse the cache (call count stays 1), SSM failure returns `Err` naming the parameter and the logged text contains no value.
    - _Requirements: 7.5, 9.7_
  - [ ] 7.6 Implement `RequestIdMiddleware`
    - Reuse the incoming `X-Request-Id`, otherwise generate one with `crypto.randomUUID()` (Node built-in, no extra dependency); set it on `req` (for example `req.requestId`) and on the response header for every route. It runs before the logger and the origin guard so both read the same id.
    - Unit tests: header reused, header generated when absent (spy on `crypto.randomUUID` and assert it is called exactly once and its value is returned), non-empty generated value.
    - _Requirements: 8.4_
  - [ ] 7.7 Property test for request id propagation (Property 4)
    - **Property 4: Request-Id propagation**
    - **Validates: Requirements 8.4**
    - `fast-check` with random header values (including absent) against a minimal Express app using the middleware through `supertest`.
    - _Requirements: 8.4_
  - [ ] 7.8 Implement the JSON request logger
    - `infrastructure/http/middleware/request-logger.middleware.ts` and a small `JsonLogger`: one line per request with `requestId`, `method`, `path`, `statusCode`, `durationMs` on `res.on('finish')`. The logger never logs the `x-origin-verify` header, other headers, or bodies.
    - Tests: the emitted line has the five fields and valid JSON; a request carrying `x-origin-verify: secret-value` produces output that does not contain `secret-value`.
    - _Requirements: 10.5, 17.1, 17.2_
  - [ ] 7.9 Implement `OriginGuardMiddleware`
    - Reject with 403 and `{ statusCode: 403, code: 'FORBIDDEN_ORIGIN', message, details: [] }` when the header is missing or differs, using the helper from 7.4 and the provider from 7.5. Log a warning with the `requestId` set by `RequestIdMiddleware` (7.6) and reason `missing_header` or `invalid_header`. The body and the log never contain the expected or received value.
    - Unit tests: missing header, wrong header, correct header calls `next`, warning reason values and request id, response body has no secret.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 17.2, 17.3_
  - [ ] 7.10 Property test, guard rejects without a valid secret (Property 1)
    - **Property 1: Origin guard rejects every request without a valid secret**
    - **Validates: Requirements 9.1, 9.2, 9.5, 9.6**
    - `fast-check`: random methods, random paths (including `/api/v1/health` and unknown routes) and random header values different from the secret; assert 403, exact error envelope, and that neither the secret nor the received value appears in the body.
    - _Requirements: 9.1, 9.2, 9.5, 9.6_
  - [ ] 7.11 Property test, guard passes on a valid secret (Property 2)
    - **Property 2: Origin guard passes through on a valid secret**
    - **Validates: Requirements 9.3**
    - `fast-check`: random methods and paths with the correct header reach a probe handler (handler spy called once).
    - _Requirements: 9.3_
  - [ ] 7.12 Implement `ResultExceptionFilter`
    - Single filter returning `{ statusCode, code, message, details }`, no stack trace, logs the full error server-side as JSON without secrets. Unknown errors map to 500 `INTERNAL_ERROR` with a generic message; `HttpException` keeps its status (for example 404 `NOT_FOUND` for unknown routes).
    - Example tests: one per mapped error type, assert the envelope shape and that `stack` is absent.
    - _Requirements: 8.6, 10.6, 14.4, 17.1_
  - [ ] 7.13 Property test, error responses never leak internals (Property 5)
    - **Property 5: Error responses never leak internals**
    - **Validates: Requirements 8.6, 10.6, 17.2**
    - `fast-check`: random thrown errors (random messages, stacks, attached env-like values); assert the response body has no stack-trace-shaped text (`at ` frames), no configured secret and no environment value.
    - _Requirements: 8.6, 10.6, 17.2_
  - [ ] 7.14 Implement `HealthController`, `AppModule` and the app factory with supertest tests (Property 3)
    - **Property 3: Health endpoint responds without side-effecting calls**
    - **Validates: Requirements 8.1, 8.2**
    - `health.controller.ts` returns `{ status: 'ok' }` with no injected dependencies. `app.module.ts` applies `RequestIdMiddleware`, `RequestLoggerMiddleware` and `OriginGuardMiddleware` (in that order) to all routes. Add `createApp()` (shared by `main.ts` and `lambda.ts`) that sets the global prefix `api/v1`, the exception filter and returns the initialized app.
    - supertest tests with the secret provider stubbed: valid header returns 200 and `{"status":"ok"}`; no header returns 403; unknown route `/api/v1/unknown` with a valid header returns a JSON 404 envelope; every response has `X-Request-Id`; with SSM, DynamoDB and payment clients mocked (`aws-sdk-client-mock`, spies), a few representative health requests produce zero calls to them.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 9.6, 3.7_
  - [ ] 7.15 Implement `main.ts` and `lambda.ts`
    - Install `aws-lambda` types and a serverless HTTP adapter for Express (Function URL events). `main.ts`: `loadConfig()`, on `Err` exit with a message naming the variable, otherwise `createApp()` and `listen`. `lambda.ts`: module-level cached server initialized once per container; on config or SSM failure throw a startup error that names the parameter or variable only. Both files stay excluded from coverage.
    - Keep logic out of these files: extract anything testable (for example `bootstrap.ts` with `initServer(deps)` that is injected with config loader and secret provider) and cover it with Jest tests: one init per many invocations (loader called once), failing config rejects with the variable name only.
    - _Requirements: 7.2, 7.4, 9.7, 10.2_
  - [ ] 7.16 Add the esbuild bundle and align the packaging scripts with `deploy.yml`
    - `api/tsconfig.build.json` (CommonJS, `experimentalDecorators`, `emitDecoratorMetadata`, `outDir: build`, tests excluded) and `api/scripts/build-lambda.ts` (run with `tsx`): step 1 `tsc -p tsconfig.build.json`; step 2 esbuild bundles `build/lambda.js` into `api/dist/lambda.js` (platform node, target node22, CommonJS, minify, no sourcemap upload) with `external` for the unused optional NestJS packages (`@nestjs/microservices`, `@nestjs/microservices/microservices-module`, `@nestjs/websockets`, `@nestjs/websockets/socket-module`, `class-transformer/storage`). Never bundle the `.ts` sources directly with esbuild: it drops decorator metadata and Nest dependency injection fails at runtime even though the `ts-jest` tests pass. `npm run build` runs the script. `dist/` must contain only `lambda.js`, so that `(cd dist && zip -qr ../lambda.zip .)` in `deploy.yml` puts `lambda.js` at the zip root (the Lambda handler is `lambda.handler`). There is no `npm run package` script: zipping is done by the workflow, and `lambda.zip` is git-ignored.
    - Jest integration test: run the bundler into a temp dir, assert the output directory holds exactly one `lambda.js`, that it exports `handler`, is smaller than a sane limit (for example 10 MB) and contains no `.env` values. Add an assertion that `package.json` defines no `package` script and that `build` ends with the bundler.
    - Bundled boot test (Requirement 10.1a): start a local HTTP stub that answers the SSM `GetParameter` call, point `AWS_ENDPOINT_URL_SSM` at it with dummy credentials and the required env vars, `require` the bundled `dist/lambda.js`, invoke `handler` with a Function URL (payload v2) event for `GET /api/v1/health` carrying the matching `X-Origin-Verify`, and assert status 200 and body `{"status":"ok"}`; a second invocation must not call the stub again (cold-start cache).
    - _Requirements: 10.1, 10.1a, 10.2, 10.3, 21.9_

- [ ] 8. Checkpoint, API runtime
  - Run in `api/`: `npm run lint`, `npx tsc --noEmit`, `npm run depcruise`, `npm test -- --coverage` (all four metrics at least 80, working target 90), `npm run build`; run `bash scripts/check-forbidden-words.sh`.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 3.6, 6.6_

- [ ] 9. Terraform base infrastructure (`infra/`)
  - [ ] 9.1 Create providers, partial S3 backend, variables and Terraform version pin
    - `providers.tf`: `terraform { required_version, required_providers { aws, random, archive }, backend "s3" { use_lockfile = true, encrypt = true } }` (partial backend: no `bucket`, `key` or `region` literals; the workflow passes them with `-backend-config`), `provider "aws" { region = "us-east-1" }`. No DynamoDB lock table.
    - `variables.tf`: `budget_notification_email` (no default, with a validation message naming the variable), `payment_api_url` (used by CSP `connect-src`), `payment_public_key` (public value, non-secret placeholder default), `project_name` default, `lambda_artifact_path` optional.
    - _Requirements: 12.1, 12.2, 16.4, 13.7_
  - [ ] 9.2 Define the private web bucket
    - `s3.tf`: `aws_s3_bucket.web`, public access block (all four flags true), bucket policy allowing `s3:GetObject` only to `cloudfront.amazonaws.com` with `AWS:SourceArn` equal to the distribution ARN.
    - _Requirements: 12.3_
  - [ ] 9.3 Define the five DynamoDB tables
    - `dynamodb.tf`: `billing_mode = "PROVISIONED"`, no autoscaling resources, no point-in-time recovery. Capacity: `products` 2/1; `customers` 2/2 with GSI `email` 1/1; `transactions` 3/3 with GSI `reference` 1/1; `deliveries` 2/2; `idempotency_keys` 1/2 with TTL on `expiresAt`. Total 12 RCU and 12 WCU.
    - _Requirements: 12.8, 12.9, 12.10, 16.3_
  - [ ] 9.4 Define the SSM SecureString parameters and the generated origin secret
    - `ssm.tf`: one standard `SecureString` parameter `/<project_name>/origin/verify-secret` with the default AWS managed key (no `key_id`), value from `random_password.origin_verify` (length 48, `special = false`), which also feeds the CloudFront custom header. The three Payment_Secret_Parameters (`/<project_name>/payment/private-key`, `/<project_name>/payment/integrity-secret`, `/<project_name>/payment/events-secret`) are NOT declared as `aws_ssm_parameter` resources or data sources: a `locals` block builds only their names and ARNs (Lambda environment and IAM policy), so their values never enter the state or a plan. No real secret in any `.tf` file.
    - _Requirements: 12.11, 12.11a, 12.11b, 13.2, 6.1_
  - [ ] 9.5 Define the Lambda function, Function URL, IAM role and log group
    - `lambda.tf`: runtime `nodejs22.x`, handler `lambda.handler`, `memory_size = 512`, `timeout = 15`, Function URL with `authorization_type = "NONE"` plus two `aws_lambda_permission` resources, `lambda:InvokeFunctionUrl` (`principal = "*"`, `function_url_auth_type = "NONE"`) and `lambda:InvokeFunction` (`principal = "*"`, `invoked_via_function_url = true` if the pinned AWS provider supports it) — without both, CloudFront gets 403 from the Function URL (Requirement 12.7a); log group `/aws/lambda/<name>` with `retention_in_days = 7`. Initial code from a tiny placeholder zip (`archive_file`) with `lifecycle { ignore_changes = [filename, source_code_hash] }` so `deploy-api` owns the real code and later applies do not revert it. Environment variables: parameter names (not values), table names (`DYNAMODB_TABLE_PRODUCTS`, `DYNAMODB_TABLE_CUSTOMERS`, `DYNAMODB_TABLE_TRANSACTIONS`, `DYNAMODB_TABLE_DELIVERIES`, `DYNAMODB_TABLE_IDEMPOTENCY_KEYS`, each set to the matching `aws_dynamodb_table` name), fee values, `PAYMENT_API_URL` from `var.payment_api_url`, `PAYMENT_PUBLIC_KEY` from `var.payment_public_key`.
    - IAM role with least privilege: `ssm:GetParameter` on the four parameter ARNs, DynamoDB item and query actions on the five table ARNs and `table/*/index/*`, `logs:CreateLogStream` and `logs:PutLogEvents` on its own log group. No wildcard resources except the index suffix.
    - _Requirements: 12.7, 12.7a, 12.12, 12.13, 10.3, 10.4, 17.4_
  - [ ] 9.6 Define the SPA rewrite CloudFront Function
    - `cloudfront_function.tf`: `aws_cloudfront_function.spa_rewrite` (runtime `cloudfront-js-2.0`, `viewer-request`), body inline between marker comments `// SPA_REWRITE_START` and `// SPA_REWRITE_END`. Rewrite to `/index.html` when the URI has no file extension and does not start with `/api/`; otherwise return the request unchanged. Inline keeps the repository free of `.js` logic files.
    - _Requirements: 12.5, 14.1, 14.2_
  - [ ] 9.7 Define the Response Headers Policy
    - In `cloudfront.tf` (or `cloudfront_headers.tf`): `aws_cloudfront_response_headers_policy.security` with `Strict-Transport-Security`, `Content-Security-Policy` (`default-src 'self'`, `script-src`, `style-src`, `img-src` `'self'`, `connect-src 'self'` plus `var.payment_api_url`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (custom header block).
    - _Requirements: 13.3, 13.7_
  - [ ] 9.8 Define the CloudFront distribution
    - `cloudfront.tf`: OAC for S3; origin S3 (default behavior) with the SPA function on `viewer-request`; origin Lambda Function URL (domain derived from the URL, `https-only`) with custom header `X-Origin-Verify` whose value is `random_password.origin_verify.result`; ordered behavior `/api/*` with the managed CachingDisabled policy, all HTTP methods allowed, the managed `AllViewerExceptHostHeader` origin request policy, and the security headers policy on both behaviors; `viewer_protocol_policy = "redirect-to-https"`; `cloudfront_default_certificate = true`; no `custom_error_response` blocks; `default_root_object = "index.html"`.
    - _Requirements: 12.4, 12.5, 12.6, 13.1, 13.2, 14.4, 15.3_
  - [ ] 9.9 Define the budget alarm
    - `budget.tf`: `aws_budgets_budget` 1 USD monthly, notification `ACTUAL` at 80% and `FORECASTED` at 100%, recipient `var.budget_notification_email`.
    - _Requirements: 16.1, 16.2, 16.4_
  - [ ] 9.10 Define the outputs
    - `outputs.tf`: `distribution_domain_name`, `distribution_id`, `web_bucket_name`, `lambda_function_name` (the four values `deploy.yml` reads); `origin_verify_secret` only if exposed, with `sensitive = true`.
    - _Requirements: 12.16, 13.2, 21.11_
  - [ ] 9.11 Static test of the Terraform files
    - Jest test `api/test/infra/terraform-static.spec.ts` that reads `infra/*.tf` (not `infra/bootstrap`) as text: region is `us-east-1`; `backend "s3"` is present with `use_lockfile = true` and `encrypt = true` and has no `bucket`, `key` or `region` literal; no `dynamodb_table` argument and no DynamoDB lock table; none of `aws_api_gateway`, `aws_apigatewayv2`, `aws_vpc`, `aws_nat_gateway`, `aws_db_instance`, `aws_rds`, `aws_secretsmanager`, `aws_wafv2`, `aws_route53`, `aws_lb`, `aws_alb`, `PAY_PER_REQUEST` appear; every DynamoDB table uses `PROVISIONED`; summed read and write capacity of tables and GSIs equals 12 and 12 (at most 25 each); `retention_in_days = 7`; `memory_size = 512`, `timeout = 15`, `nodejs22.x`, both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` permissions; no `custom_error_response`; `redirect-to-https`; the six security header names are present; `budget_notification_email` has no default; `ssm.tf` has a `random_password` for the origin secret and no `key_id`; no `aws_ssm_parameter` resource or `data "aws_ssm_parameter"` refers to a `/payment/` name anywhere in `infra/`; the origin header value references the `random_password` result; no string matching `prv_`; no forbidden word.
    - _Requirements: 12.1, 12.2, 12.5, 12.6, 12.7, 12.7a, 12.8, 12.9, 12.11, 12.11a, 12.11b, 12.12, 12.14, 13.2, 13.3, 16.3, 16.4, 6.5_
  - [ ] 9.12 Property test of the SPA rewrite logic (Property 10)
    - **Property 10: SPA rewrite applies only to extension-less, non-API paths**
    - **Validates: Requirements 14.1, 14.2**
    - Jest test `api/test/infra/spa-rewrite.spec.ts`: extract the function body between the markers in `cloudfront_function.tf`, evaluate it with `new Function`, and with `fast-check` generate random paths (with and without extension, with and without the `/api/` prefix, nested segments). Assert the rewrite only for extension-less non-API paths and no change otherwise. Include example cases `/`, `/some/deep/route`, `/assets/app.abc123.js`, `/api/v1/unknown-route`.
    - _Requirements: 14.1, 14.2, 14.3, 14.4_
  - [ ] 9.13 Format and validate Terraform locally (no backend, no AWS calls)
    - In `infra/`: run `terraform fmt -check -recursive`, `terraform init -backend=false`, `terraform validate`. Never run `terraform init` with the S3 backend, `plan` or `apply`. Also confirm that validation without `budget_notification_email` fails and names the variable (do not run `terraform plan`).
    - If the Terraform CLI is not installed, report that and do not skip silently.
    - _Requirements: 12.15, 16.4_

- [ ] 10. Bootstrap module (`infra/bootstrap`)
  - [ ] 10.1 Create the bootstrap module skeleton and the state bucket
    - `infra/bootstrap/main.tf`, `variables.tf`, `outputs.tf`: `terraform` block with `required_providers` and NO `backend` block (local state), `provider "aws" { region = "us-east-1" }`. Variables `github_owner`, `github_repo`, `state_bucket_name`, `project_name` (no defaults). Resources `aws_s3_bucket.state` (`force_destroy = false`), `aws_s3_bucket_versioning.state` (Enabled), `aws_s3_bucket_server_side_encryption_configuration.state` (`AES256`), `aws_s3_bucket_public_access_block.state` (all four true). Output `state_bucket_name`.
    - Jest test `api/test/infra/bootstrap-state.spec.ts` (text-based): no `backend` block, region `us-east-1`, versioning `Enabled`, SSE `AES256`, all four public access flags `true`, the four variables exist, no secret-like strings, no `aws_access_key` or `aws_iam_user`.
    - _Requirements: 19.1, 19.2, 19.5, 19.6, 19.9_
  - [ ] 10.2 Add the OIDC provider and the deploy role trust policy (Property 12)
    - **Property 12: Deploy role trust policy admits only this repository's master branch and production environment**
    - **Validates: Requirements 20.1, 20.2, 20.3**
    - Append to `main.tf`: `aws_iam_openid_connect_provider.github` (`url = "https://token.actions.githubusercontent.com"`, `client_id_list = ["sts.amazonaws.com"]`), `data.aws_iam_policy_document.deploy_trust` exactly as in the design (single action `sts:AssumeRoleWithWebIdentity`, principal type `Federated` = the provider ARN, `StringEquals` on `aud` and on `sub` with the two subjects built from `var.github_owner`/`var.github_repo`, never `StringLike` or wildcards) and `aws_iam_role.deploy` with `max_session_duration = 3600`. Add output `deploy_role_arn` to `outputs.tf`.
    - Test helper `api/test/infra/helpers/trust-policy.ts`: parses the trust policy block from the HCL text into `{ actions, principals, tests, aud, subs }` and evaluates a claim set against it. Test `api/test/infra/bootstrap-trust.spec.ts`: example assertions of the static structure (single action, `StringEquals`, no `*`, `max_session_duration = 3600`, provider URL and client id); `fast-check` generates `sub` and `aud` values (other owners and repos, other branches, `pull_request` refs, other environments, prefix and wildcard variants) and asserts admission if and only if `aud` is `sts.amazonaws.com` and `sub` is one of the two exact subjects for `salgado-2022/card-checkout-store`.
    - _Requirements: 19.3, 19.4, 19.6, 20.1, 20.2, 20.3, 20.9_
  - [ ] 10.3 Add the least-privilege deploy role permission policy
    - Append to `main.tf`: `aws_iam_role_policy.deploy` with one statement per service as in the design table (S3 state with `GetObject`/`PutObject`/`DeleteObject`/`ListBucket`/`GetBucketVersioning` on the State_Bucket only; S3 web, Lambda, DynamoDB, CloudWatch Logs and Budgets scoped to the `project_name` prefix; SSM scoped to `parameter/<project_name>/origin/*` only, with no action on `/<project_name>/payment/*`; CloudFront on `*` because it has no name-scoped creation ARNs; IAM limited to `role/<project_name>-lambda-*` with `iam:PassRole` conditioned on `iam:PassedToService = lambda.amazonaws.com`). Use `data.aws_caller_identity` for the account id.
    - Jest test `api/test/infra/bootstrap-policy.spec.ts` (text-based): no `"*:*"`, no `iam:*`, no `iam:CreateUser`, no `iam:CreateAccessKey`, no `Resource = "*"` outside the allowed actions (CloudFront actions, `ssm:DescribeParameters`, `logs:DescribeLogGroups`); every IAM statement has a `role/${var.project_name}-lambda-` resource; S3, Lambda, DynamoDB, SSM and Logs resources contain the `project_name` prefix; the State_Bucket statement includes the bucket and `bucket/*` (lock file); the SSM statement covers only `/origin/` and nothing grants access to `/payment/`; no statement references the OIDC provider or the deploy role itself; only the eight services of Requirement 20.4 appear.
    - _Requirements: 20.4, 20.5, 20.5a, 20.6, 20.7, 20.8_
  - [ ] 10.4 Format and validate the bootstrap module locally
    - In `infra/bootstrap/`: run `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`. Never run `plan` or `apply`. Leave the `.terraform/` directory in place (it is git-ignored, and agents cannot delete files). If the Terraform CLI is not installed, report that and do not skip silently.
    - _Requirements: 19.8_

- [ ] 11. Deploy pipeline and smoke test
  - [ ] 11.1 Create `scripts/smoke-test.sh` with its test (Property 16)
    - **Property 16: Smoke test passes if and only if status, headers and body are all correct**
    - **Validates: Requirements 23.2, 23.3, 23.4, 23.5, 23.6**
    - Bash script taking the base URL (`set -euo pipefail`). For `/` and `/api/v1/health` it runs `curl -sS -D headers.txt -o body.txt` with no `X-Origin-Verify` header, up to 5 attempts, `sleep` between attempts from `SMOKE_RETRY_DELAY` (default 5). A check passes when the status is 200, the six headers (`strict-transport-security`, `content-security-policy`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, `permissions-policy`, case-insensitive) are present and, for health, the body equals `{"status":"ok"}`. On final failure print `FAILED: <check name>` (for example `FAILED: GET /api/v1/health missing header x-frame-options`) and exit non-zero. Without an argument it exits non-zero with a usage message.
    - Jest test `api/test/scripts/smoke-test.spec.ts`: start a local `http` server, run the script through `child_process` with `SMOKE_RETRY_DELAY=0`; `fast-check` generates status codes, subsets of the six headers and health bodies; assert exit code iff all correct, the printed failed-check name, that the server never received `x-origin-verify`, and that a persistently failing path receives exactly 5 requests. Example: a transient failure followed by success passes.
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 24.9_
  - [ ] 11.2 Create `.github/workflows/deploy.yml`
    - Implement the workflow exactly as in the design: triggers `workflow_run` on workflow `ci` (types `completed`, branches `master`) and `workflow_dispatch` (no `push`, no `pull_request`); workflow-level `DEPLOY_SHA` (`github.event.workflow_run.head_sha || github.sha`) used as `ref` by every checkout; the `plan` job's `if` requires `workflow_dispatch` or a `success` CI run of a `push` event whose `head_repository.full_name` equals `github.repository`; workflow permissions `contents: read`; `concurrency` group `deploy-production` with `cancel-in-progress: false`; jobs `plan` (no environment: checkout, OIDC credentials with `role-arn` from `vars.AWS_ROLE_ARN`, setup-terraform, `terraform fmt -check -recursive`, `terraform init` with `-backend-config` for bucket, key and region from variables, `terraform validate`, `terraform plan -input=false -out=tfplan`, plan summary in `GITHUB_STEP_SUMMARY`; the plan file never leaves the runner), `apply` (`environment: production`, `needs: plan`, init, then `terraform plan -input=false -out=tfplan` and `terraform apply -input=false tfplan` in the same job, exposes Lambda name, web bucket, distribution id and domain as job outputs), `deploy-api` (`environment: production`, `npm ci && npm run build && (cd dist && zip -qr ../lambda.zip .)`, `aws lambda update-function-code`, `aws lambda wait function-updated`), `deploy-web` (`environment: production`, build with `VITE_API_BASE`, `VITE_PAYMENT_API_URL` and `VITE_PAYMENT_PUBLIC_KEY` from variables, `aws s3 sync` with `Cache-Control: public, max-age=31536000, immutable` excluding `index.html`, `aws s3 cp index.html` with `Cache-Control: no-cache`, `aws cloudfront create-invalidation`), `smoke-test` (`contents: read` only, runs `bash scripts/smoke-test.sh`). Jobs that call AWS declare `id-token: write` and `contents: read`. Pass `TF_VAR_budget_notification_email` and `TF_VAR_payment_api_url` from variables, and `TF_VAR_payment_public_key` from `vars.PAYMENT_PUBLIC_KEY`. No access keys, no `secrets.` expression, no `terraform destroy`, no step that prints SSM values or the origin secret, and no `actions/upload-artifact` or `actions/download-artifact` (artifacts of a public repository are downloadable and plan files hold secrets in plain text).
    - Run `terraform`-free local checks only: parse the YAML with the `yaml` package to confirm it is valid.
    - _Requirements: 5.10, 14.5, 14.6, 20.10, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.9, 21.10, 21.11, 21.12, 21.13, 21.14, 21.15, 22.1, 22.3, 22.4, 22.5_
  - [ ] 11.3 Test `deploy.yml` structure (Property 15)
    - **Property 15: `deploy.yml` job order, gating and permissions**
    - **Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.6, 21.8, 22.1, 22.3, 22.4**
    - Jest test `api/test/infra/deploy-workflow.spec.ts` (`yaml` parser) iterating the parsed `jobs` map: triggers are exactly `workflow_run` (workflow `ci`, `completed`, branch `master`) and `workflow_dispatch`, and the `plan` job's `if` checks `conclusion == 'success'`, `event == 'push'` and the same repository; every checkout uses `DEPLOY_SHA`; every job's permissions are a subset of `{ id-token: write, contents: read }` and every job that calls AWS has both; the `needs` graph is the chain `plan` -> `apply` -> `deploy-api` -> `deploy-web` -> `smoke-test`; `apply`, `deploy-api`, `deploy-web` declare `environment: production`, `plan` declares none; `terraform apply` appears only in `apply`, after a `terraform plan -out=tfplan` step in the same job, and with `tfplan` as the argument; no step uses `actions/upload-artifact` or `actions/download-artifact`; `concurrency` has `cancel-in-progress: false`; within `plan` the steps run in the order `fmt -check`, `init`, `validate`, `plan`; `init` receives `-backend-config` for the bucket from `TF_STATE_BUCKET`; the assets sync contains `max-age=31536000, immutable`, `index.html` upload contains `no-cache`, and a `create-invalidation` step exists; the deploy-api job runs `update-function-code`. A small mutation helper checks that the assertions fail for variants: a job with extra permissions, a missing `environment`, `cancel-in-progress: true`, `apply` inside `plan`, an `upload-artifact` step, a `push` trigger.
    - _Requirements: 14.5, 14.6, 21.1, 21.2, 21.3, 21.4, 21.6, 21.8, 21.9, 21.10, 21.15, 22.1, 22.3, 22.4_
  - [ ] 11.4 Test that workflows and scripts contain no destroy and no long-lived AWS credentials (Property 13)
    - **Property 13: Workflows contain no destroy and no long-lived AWS credentials**
    - **Validates: Requirements 15.6, 20.10, 21.5, 21.13**
    - Reuse `api/test/tooling/helpers/workflow-scanner.ts` (task 4.4) with a second rule set: `terraform destroy`, `-destroy`, `aws-access-key-id`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AKIA[0-9A-Z]{16}`, and `secrets.` in `deploy.yml`. Test `api/test/infra/no-destroy-no-keys.spec.ts`: `fast-check` injects each forbidden token into random text and asserts detection, clean text passes; the scanner then runs on every file in `.github/workflows/` and on every file in `scripts/` and reports zero violations. Also assert that `deploy.yml` uses `aws-actions/configure-aws-credentials` with `role-arn` and no access key inputs, and that no `terraform apply` string exists in `ci.yml` or in `scripts/`.
    - _Requirements: 15.5, 15.6, 15.7, 20.10, 21.5, 21.13_

- [ ] 12. Documentation
  - [ ] 12.1 Write the deployment documentation with a content test
    - `docs/deployment.md` and `infra/README.md` in English, ordered as in the design: (1) prerequisites, (2) run `infra/bootstrap` once with `terraform init`, `terraform plan`, `terraform apply` and read the outputs `deploy_role_arn` and `state_bucket_name`, keep the local state file outside git, (3) create the `production` environment with at least one required reviewer, (4) Deploy_Variables table (`AWS_ROLE_ARN`, `AWS_REGION`, `TF_STATE_BUCKET`, `BUDGET_NOTIFICATION_EMAIL`, `PAYMENT_API_URL`, `PAYMENT_PUBLIC_KEY`) with scope and source of each value, (5) trigger and approve the first run, (6) create the three Payment_Secret_Parameters before the first run with `aws ssm put-parameter --type SecureString --value file://<local-file>` (add `--overwrite` to change one later, then re-run the workflow), (7) run `scripts/smoke-test.sh` and the manual `curl -I` checks (six headers on `/` and `/api/v1/health`, health body, direct Function URL returns 403, deep link returns `index.html`, HTTP redirects to HTTPS, unknown API route returns JSON 4xx), (8) statement that real payment secrets are never stored in GitHub, Terraform files or the repository, and that agents and CI never apply or destroy outside `deploy.yml`. `infra/README.md` documents local `terraform fmt`, `init -backend=false` and `validate`, and points to `docs/deployment.md`.
    - Jest test `api/test/docs/deployment-docs.spec.ts`: the required headings exist, every Deploy_Variable name appears, and the text contains no forbidden word, no `prv_` and no instruction to run `terraform destroy`.
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 13.4, 13.5, 13.6, 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9_
  - [ ] 12.2 Update the root README
    - Link to `docs/deployment.md`, add the public environment placeholder, the automatic deployment note (GitHub Actions with approval) and the cost note (always-free tier, 1 USD budget alarm). English only. Extend the test of task 1.3 to assert the link to `docs/deployment.md`.
    - _Requirements: 18.1, 16.1, 24.1_

- [ ] 13. Checkpoint, `feat/infra-base`
  - Run in `api/` and `web/`: `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage` (confirm all four metrics are at least 80 in each project), `npm run build`; run `npm run depcruise` in `api/`; run `terraform fmt -check -recursive`, `terraform init -backend=false` and `terraform validate` in `infra/` and in `infra/bootstrap/`; run `bash scripts/check-forbidden-words.sh` and confirm it reports no findings.
  - Do not run `terraform plan` or `terraform apply`.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 3.6, 6.6, 12.15, 19.8_

- [ ] 14. **[MANUAL — developer only]** Commit, bootstrap, deploy and verify
  - Agents skip this whole section. Order matters: steps 14.2, 14.3 and 14.4 must be finished before merging the PR, because the green CI run on `master` after the merge starts `deploy.yml`.
  - [ ] 14.1 **[MANUAL]** Commit, push and open the `feat/infra-base` pull request
    - Create branch `feat/infra-base`, commit in small Conventional Commits (for example `feat(api): add config loader`, `feat(api): add origin guard and health`, `feat(infra): add terraform base`, `feat(infra): add bootstrap module`, `ci: add deploy workflow`, `docs: add deployment guide`), push, open the PR and wait for green CI. Do not merge yet.
    - Agents must not run `git commit` or `git push`.
    - _Requirements: 18.5_
  - [ ] 14.2 **[MANUAL]** Run `infra/bootstrap` once with your own AWS credentials
    - In `infra/bootstrap/` with your own credentials: `terraform init`, `terraform plan -var ...`, review, `terraform apply` (`github_owner=salgado-2022`, `github_repo=card-checkout-store`, a globally unique `state_bucket_name`, `project_name`). Note the outputs `deploy_role_arn` and `state_bucket_name`. Keep the local state file outside git.
    - Agents must not run `terraform apply` or `terraform destroy`.
    - _Requirements: 19.1, 19.4, 19.6, 24.2, 24.8_
  - [ ] 14.3 **[MANUAL]** Create the GitHub Environment and load the Deploy_Variables
    - Create the Environment `production` with at least one required reviewer. Set the repository variables `AWS_ROLE_ARN`, `AWS_REGION` (`us-east-1`), `TF_STATE_BUCKET`, `BUDGET_NOTIFICATION_EMAIL`, `PAYMENT_API_URL`, `PAYMENT_PUBLIC_KEY` (variables, never secrets; no AWS access keys anywhere).
    - _Requirements: 22.2, 24.3, 24.4, 20.10_
  - [ ] 14.4 **[MANUAL]** Create the three payment secrets in SSM
    - With your own AWS credentials, before the first deploy: `aws ssm put-parameter --type SecureString --name /<project_name>/payment/private-key --value file://<local-file>`, and the same for `integrity-secret` and `events-secret`, with the real sandbox values. Reading from a local file keeps the values out of shell history; delete the files afterwards. Never paste values into the repository, GitHub, chat or Terraform. Terraform never manages these parameters.
    - _Requirements: 6.1, 12.11a, 24.6, 24.7_
  - [ ] 14.5 **[MANUAL]** Merge and approve the first deploy
    - Squash merge the PR to `master` (or trigger `workflow_dispatch` from `master`); `deploy.yml` starts when `ci.yml` finishes green on `master`. Read the plan summary of the `plan` job, approve the `production` gate and wait for `apply`, `deploy-api`, `deploy-web` and `smoke-test` to finish. Confirm the budget subscription email.
    - _Requirements: 15.5, 21.1, 22.2, 22.3, 24.5_
  - [ ] 14.6 **[MANUAL]** Verify with curl and re-run the deploy if needed
    - Run `bash scripts/smoke-test.sh https://<distribution-domain>` and the manual checks: `curl -I` returns the six security headers on `/` and `/api/v1/health`; health returns 200 and `{"status":"ok"}`; `GET /some/deep/route` returns 200 `index.html`; `GET /api/v1/unknown-route` returns a JSON 4xx; the Function URL called directly returns 403; HTTP redirects to HTTPS. If anything fails, re-run the workflow (`workflow_dispatch`) and approve it. Save evidence for the README.
    - _Requirements: 8.5, 13.4, 13.5, 13.6, 14.3, 14.4, 15.1, 15.2, 15.3, 23.1, 24.9, HU-17_

## Notes

- Suggested branches: `chore/repo-setup` (epics 1–6) and `feat/infra-base` (epics 7–14). One PR per branch, squash merge to `master`.
- Manual tasks (6 and 14.1–14.6) are never executed by agents. Agents report readiness and stop at those tasks.
- Agents only run `terraform fmt`, `terraform init -backend=false` and `terraform validate`. Apply happens only inside `deploy.yml` after approval on `production`, and the one-time `infra/bootstrap` apply is done by the Developer.
- Requirements mapping to rubric items: coverage gate (2.3, 2.4, 3.3), CI (4.1, 4.4), hexagonal rule (2.5), ROP (7.1, 7.5), OWASP/HTTPS/headers (7.9, 9.7, 9.8, 10.2, 10.3), deployment (9.x, 10.x, 11.x, 14.x), README (1.3, 12.2).
- Explicit coverage of criteria 3.6, 6.2 and 6.6: 3.6 in checkpoints 5, 8 and 13; 6.2 in 4.1 and 4.2 (gitleaks step, run by CI); 6.6 in 4.1, 4.2 and checkpoints 5, 8 and 13.
- Web jest `getEnv` wrapper and the workflow's forbidden-words skip behavior are implementation details left to the developer agent within the stated constraints.
- Property 9 is an integration-style single-run check. Properties 3, 8 and 11 are integration-style checks with representative fixtures. Properties 12, 13 and 14 combine static structure assertions with `fast-check` over a scanner or evaluator. Property 15 is an example-style test over `deploy.yml` with mutations. Property 16 uses `fast-check` against a local HTTP server. The remaining properties use `fast-check` directly.
- The CloudFront Function body is kept inline in Terraform to respect the "no `.js` logic files" rule.
- `deploy.yml` also passes `TF_VAR_payment_public_key` from `vars.PAYMENT_PUBLIC_KEY`, because the Lambda configuration validates `PAYMENT_PUBLIC_KEY` at startup. The design's workflow listing includes the same three `TF_VAR_` entries.
- Runtime is Node.js 22 (`nodejs22.x`) everywhere; `nodejs20.x` is no longer a supported Lambda runtime.
- Heads-up for the `payments-api` spec: Swagger UI needs static assets and inline styles that do not fit a single-file Lambda bundle or the `'self'` CSP. Plan to serve Swagger UI as static files from the Web_Bucket under `/docs`, with an `openapi.json` generated at build time.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "3.2"] },
    { "id": 4, "tasks": ["2.3", "3.3"] },
    { "id": 5, "tasks": ["2.4", "2.5", "3.4", "3.5"] },
    { "id": 6, "tasks": ["3.6"] },
    { "id": 7, "tasks": ["3.7", "4.1"] },
    { "id": 8, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 9, "tasks": ["5"] },
    { "id": 10, "tasks": ["6"] },
    { "id": 11, "tasks": ["7.1"] },
    { "id": 12, "tasks": ["7.2", "7.3", "7.4", "7.5", "7.6"] },
    { "id": 13, "tasks": ["7.7", "7.8", "7.9"] },
    { "id": 14, "tasks": ["7.10", "7.11", "7.12"] },
    { "id": 15, "tasks": ["7.13", "7.14"] },
    { "id": 16, "tasks": ["7.15"] },
    { "id": 17, "tasks": ["7.16"] },
    { "id": 18, "tasks": ["8"] },
    { "id": 19, "tasks": ["9.1"] },
    { "id": 20, "tasks": ["9.2", "9.3", "9.4", "9.5", "9.6", "9.7"] },
    { "id": 21, "tasks": ["9.8", "9.9"] },
    { "id": 22, "tasks": ["9.10"] },
    { "id": 23, "tasks": ["9.11", "9.12"] },
    { "id": 24, "tasks": ["9.13", "10.1", "11.1", "11.2"] },
    { "id": 25, "tasks": ["10.2", "11.3", "11.4"] },
    { "id": 26, "tasks": ["10.3"] },
    { "id": 27, "tasks": ["10.4", "12.1"] },
    { "id": 28, "tasks": ["12.2"] },
    { "id": 29, "tasks": ["13"] },
    { "id": 30, "tasks": ["14.1"] },
    { "id": 31, "tasks": ["14.2"] },
    { "id": 32, "tasks": ["14.3"] },
    { "id": 33, "tasks": ["14.4"] },
    { "id": 34, "tasks": ["14.5"] },
    { "id": 35, "tasks": ["14.6"] }
  ]
}
```
