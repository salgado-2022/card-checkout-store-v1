# Card Checkout Store

A single-product card checkout store for Colombia. Prices and payments use COP, integer cents everywhere. Card payments run against a payment provider sandbox. This is a technical assessment project, not a production store.

Live environment: https://<distribution-domain> (added after the first deployment)

## Deployment

The deployment guide, with the one-time setup, the deploy variables and the verification steps, is in [docs/deployment.md](docs/deployment.md).

After CI passes on `master`, GitHub Actions runs the `deploy` workflow. It plans the infrastructure, then applies it and deploys the API and the web app to AWS (`us-east-2`). The `apply`, `deploy-api` and `deploy-web` jobs wait for a manual approval in the `production` environment, so no change reaches AWS without a reviewer.

## API documentation

- Docs site (endpoint list and Swagger UI): `https://<distribution-domain>/docs/`
- OpenAPI document: [docs/openapi.json](docs/openapi.json), also served at `https://<distribution-domain>/docs/openapi.json`
- Postman collection: [docs/postman/payments-api.postman_collection.json](docs/postman/payments-api.postman_collection.json)
- Written contract (endpoints, error codes, content-type and rate limit rules): [.kiro/steering/api-contract.md](.kiro/steering/api-contract.md)

## Rate limit

The API allows 60 requests per client IP in a sliding 60 second window, for every route under `/api/v1` except `GET /api/v1/health`. A request over the limit gets 429 `TOO_MANY_REQUESTS`, and rejected requests do not extend the block.

- The client IP comes from the `CloudFront-Viewer-Address` header. When that header is missing, the API uses the socket address (the CloudFront edge address).
- Counters live in memory in each Lambda execution environment. Several containers keep separate counters, so the limit is never stricter than 60 per minute.
- Users behind the same NAT or public address share one quota.
- A checkout that polls `GET /api/v1/transactions/:id` every 2 seconds for 60 seconds uses about 35 to 45 requests per minute, inside the limit.

## Cost

The stack uses only AWS services in the always-free tier: Lambda, DynamoDB provisioned capacity, CloudFront, S3, SSM Parameter Store and CloudWatch Logs with 7-day retention. A 1 USD AWS Budgets alarm emails the address in `BUDGET_NOTIFICATION_EMAIL` when actual spend reaches 80% of the limit and when forecast spend reaches 100%.

## Scope

- Product catalog with one product per transaction, quantity 1 to min(stock, 5).
- Card checkout with VISA and MasterCard, 1 to 36 installments.
- Customer and delivery capture, base fee and delivery fee computed by the backend.
- Card data is tokenized in the browser with the payment provider public key. The backend receives only the token, the brand and the last four digits.
- Final status by polling the payment provider, with a webhook as backup.

## Repository layout

```text
api/        NestJS backend (hexagonal: domain, application, infrastructure)
web/        React 18 SPA built with Vite
infra/      Terraform for AWS (us-east-2)
docs/       Architecture notes, Postman collection, coverage reports
scripts/    Repository scripts (forbidden-words check)
.github/    Pull request template and GitHub Actions workflows
.kiro/      Specs and steering files
```

## Requirements

- Node.js 22 LTS (see `api/.nvmrc`).
- npm.

## Commands

Run these commands inside `api/` or `web/`.

| Command | Purpose |
|---|---|
| `npm run lint` | ESLint (flat config) with typescript-eslint and Prettier |
| `npx tsc --noEmit` | Type check with `strict: true` |
| `npm test -- --coverage` | Jest tests with the 80% coverage threshold |
| `npm run build` | Production build |

Before each commit, run the forbidden-words check from the repository root:

```bash
bash scripts/check-forbidden-words.sh
```

## Environment variables

Copy `.env.example` to `.env` and fill in the values. The file lists variable names only. Payment secrets never live in the repository.
