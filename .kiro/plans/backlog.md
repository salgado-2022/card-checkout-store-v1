# Backlog

Items that must become tasks in the spec named in each entry. Remove an entry once it exists in that spec's `tasks.md`.

## checkout-web
- [ ] **WEB-01 Handle 409 IDEMPOTENCY_KEY_IN_PROGRESS.** Retry the same request with the same Idempotency-Key after 1 s (max 3 times), then show the status screen; never generate a new key for a retry.
- [ ] **CSP-01 Production CSP compatibility.** Set `build.assetsInlineLimit: 0` in `web/vite.config.ts`; card brand logos and icons as SVG components or files in `web/public/`; CSS Modules or plain CSS only (no CSS-in-JS that injects `<style>`); self-hosted fonts or system stack. Add a Jest build test that scans `web/dist` for `data:image`, inline `<script>` and inline `<style>` and fails if any is found; run it in CI after `vite build`. Acceptance: deployed site shows the brand logo inside the card field and the browser console has zero CSP violations on all five screens. Rules: `.kiro/steering/frontend-ui.md` (CSP section).

## hardening-and-docs (README)
- [ ] **DOC-01 Accepted risk: delivery and customer data by id.** `GET /deliveries/:id` and `GET /customers/:id` return personal data (name, phone, address, email, document) to anyone who knows the id. Accepted because ids are ULIDs with 80 random bits, there is no listing endpoint and there is a rate limit. State it in the README security section with the production fix (authentication or a signed, short-lived access token per order).

