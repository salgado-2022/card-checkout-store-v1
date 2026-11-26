---
inclusion: always
---
# Repository structure and conventions

```text
/
  api/                      NestJS backend
    src/
      domain/               entities, value objects (Money, CardBrand, TransactionStatus), domain errors — no framework imports
      application/
        ports/              ProductRepository, CustomerRepository, TransactionRepository, DeliveryRepository,
                            IdempotencyRepository, PaymentGateway, Clock, IdGenerator
        use-cases/          GetProducts, GetProduct, UpsertCustomer, CreateTransaction, SyncTransactionStatus,
                            FinalizeTransaction, HandlePaymentEvent, GetDelivery…
      infrastructure/
        http/               controllers, DTOs (class-validator), exception filter, Result → HTTP mapper
        persistence/        DynamoDB adapters
        payment/            payment gateway adapter, integrity signature, event checksum verification
        config/             env validation
      main.ts · lambda.ts
    test/                   (or co-located *.spec.ts)
    scripts/seed.ts
  web/                      React SPA
    src/
      app/                  store, persistence middleware (whitelist + versioned key "checkout:v1")
      features/product/     slice, thunks, components
      features/checkout/    slice, card + delivery form, validators (Luhn, brand, expiry…)
      features/transaction/ slice, polling thunk, result screen
      shared/               ui components, formatters (COP, card mask), api client
  infra/                    Terraform
  docs/                     architecture, Postman collection, coverage screenshots
  scripts/                  repo scripts (check-forbidden-words.sh)
  .github/workflows/
```

## Conventions
- Files `kebab-case.ts`; classes `PascalCase`; React components `PascalCase.tsx`; tests `*.spec.ts` (api) and `*.test.ts(x)` (web).
- Use the generic word `payment` for anything related to the provider (`PaymentGatewayAdapter`, `PAYMENT_*`).
- Branch per user story: `feat/HU-xx-short-slug`; chores: `chore/...`; docs: `docs/...`. Squash merge to `main`.
- Commits: Conventional Commits in English (`feat(api): ...`, `test(web): ...`).
- Specs live in `.kiro/specs/<name>/`.
