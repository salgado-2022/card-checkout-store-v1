---
inclusion: always
---
# Tech stack and constraints

Everything is **TypeScript** (`strict: true`), **Node.js 22 LTS** locally, in CI and in Lambda (`nodejs22.x`; `nodejs20.x` is no longer supported). No `.js` logic files.

| Layer | Use | Forbidden |
|---|---|---|
| Frontend | React 18 SPA + Vite (bundler only) + Redux Toolkit (slices + thunks) + CSS Modules/SCSS (flexbox, grid) | Next.js, Angular, Vue, heavy UI kits |
| Backend | NestJS (Express adapter) | Rails, bare Express/Fastify, any other framework |
| Result type | `neverthrow` (`Result`, `ResultAsync`) | `throw` for business errors |
| Tests | **Jest only** (`ts-jest` or `@swc/jest`), React Testing Library + user-event, msw, supertest, `aws-sdk-client-mock`, nock | Vitest, Mocha |
| Data | DynamoDB **provisioned** capacity (free tier), AWS SDK v3 | On-demand mode, RDS |
| Infra | Terraform in `infra/`, `us-east-1`, CloudFront + S3 (OAC) + CloudFront Function (SPA rewrite) + Lambda Function URL + SSM SecureString + CloudWatch Logs (7 days) | API Gateway, VPC, NAT, RDS, Secrets Manager, WAF, Route 53, load balancers |
| CI | GitHub Actions: lint, typecheck, tests with coverage threshold, build, gitleaks | — |
| Lint | ESLint v10 **flat config** (`eslint.config.mjs`, never `.eslintrc*`) + typescript-eslint v8 + Prettier; `dependency-cruiser` rule: `api/src/domain` imports nothing from NestJS, AWS SDK or HTTP libs | — |

## Commands (run inside `api/` or `web/`)
- `npm run lint` · `npx tsc --noEmit` · `npm test -- --coverage`
- Backend bundle for Lambda: `tsc -p tsconfig.build.json` first, then esbuild on the emitted JS (esbuild alone drops `emitDecoratorMetadata` and breaks Nest DI); optional Nest packages marked `external`. 512 MB, 15 s timeout; Nest app initialized once and reused.
- Lambda Function URL (auth `NONE`) needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` permissions.
- Jest `collectCoverageFrom` covers all of `src/`, so untested files count.

## Coverage
`coverageThreshold.global` = 80 for statements, branches, functions, lines in **both** projects. Working target: 90%.
Allowed exclusions only: `main.ts`, `lambda.ts`, wiring-only Nest modules, `index.tsx`/`main.tsx`, type-only files, seed script.

## Environment variables
Backend: `PAYMENT_API_URL`, `PAYMENT_PUBLIC_KEY`, `PAYMENT_PRIVATE_KEY_PARAM`, `PAYMENT_INTEGRITY_SECRET_PARAM`, `PAYMENT_EVENTS_SECRET_PARAM`, `ORIGIN_VERIFY_SECRET_PARAM`, `BASE_FEE_IN_CENTS=300000`, `DELIVERY_FEE_IN_CENTS=800000`, and the table names `DYNAMODB_TABLE_PRODUCTS`, `DYNAMODB_TABLE_CUSTOMERS`, `DYNAMODB_TABLE_TRANSACTIONS`, `DYNAMODB_TABLE_DELIVERIES`, `DYNAMODB_TABLE_IDEMPOTENCY_KEYS` — validated at startup. Use exactly these names in `.env.example`, the config schema and the Terraform Lambda environment.
Frontend: `VITE_API_BASE=/api/v1`, `VITE_PAYMENT_API_URL`, `VITE_PAYMENT_PUBLIC_KEY` (public values only).
