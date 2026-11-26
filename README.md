# Card Checkout Store

A single-product card checkout store for Colombia. Prices and payments use COP, integer cents everywhere. Card payments run against a payment provider sandbox. This is a technical assessment project, not a production store.

> Stub. The full README (architecture, deployment, API reference and screenshots) is completed in task 12.2.

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
infra/      Terraform for AWS (us-east-1)
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
