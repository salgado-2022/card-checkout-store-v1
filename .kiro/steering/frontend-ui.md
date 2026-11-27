---
inclusion: fileMatch
fileMatchPattern: ["web/src/**", "web/index.html", "web/vite.config.*", "web/public/**"]
---
# Frontend UI rules

- **Mobile first**, designed for 375 × 667 (iPhone SE 2020). No horizontal scroll or overflow from 320 to 1440 px. Touch targets ≥ 44 × 44 px, AA contrast, visible focus, labels on every input.
- Images: WebP from the CDN, explicit `width`/`height`, `loading="lazy"` below the fold, < 150 KB. Skeletons sized like the final content (no layout shift).
- Money format: `$ 120.000` (es-CO, no decimals).
- **Modal (step 2):** sections "Tarjeta" and "Entrega"; focus moves to the first field; Esc/X close; background scroll locked; full width with internal scroll under 600 px.
- **Card validation:** digits grouped by 4; VISA starts with 4 (13/16/19 digits); MasterCard 51–55 or 2221–2720 (16 digits); Luhn. Holder 5–50 letters (accents, ñ) and spaces. Expiry MM/AA, not expired, ≤ 15 years ahead. CVC exactly 3 digits, `type="password"`. Installments 1–36 (default 1). Brand logo appears inside the field. `inputmode="numeric"` for number, expiry, CVC. Errors show on blur or on submit, never while typing the first character.
- **Customer/delivery validation:** name 3–80; email ≤ 120; phone 10 digits starting with 3; document CC/CE 6–10 digits, NIT 9–10, PP 6–12 alphanumeric; address 5–120; detail ≤ 60 optional; department closed list (32 + Bogotá D.C.); city 2–60; postal code 6 digits optional. On invalid submit: no API call, mark all errors, focus the first one.
- **Summary (step 3):** Material-style backdrop, front layer slides up over the product layer in 200–300 ms. Shows product × qty, subtotal, base fee, delivery fee, total, masked card ("VISA •••• 4242"), installments, address, "Editar" link. Two unchecked terms checkboxes with permalinks; "Pagar $ X" disabled until both are checked. Pay button disables + spinner on click (single submit).
- **Status (step 4):** "Procesando tu pago" while PENDING; approved / declined / error variants with reference, total, masked card; after 30 polls show "Tu pago sigue en proceso" + "Consultar de nuevo". Final state: "Volver a la tienda" or 10 s visible countdown.
- **Persistence:** single localStorage key `checkout:v1`, schema-validated on load, expires in 24 h, whitelist only (never number, CVC or token). Refresh mapping: step 1→1, 2→2 (modal open), 3→2, 4→4 (resume polling, never create a new transaction).
- Respect `prefers-reduced-motion`.

## Content-Security-Policy compatibility (production header, set by CloudFront)
Policy: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' <payment API origin>; font-src` falls back to `'self'`. Anything that works with `vite dev` but breaks under this header is a production bug.
- **No `data:` images:** set `build.assetsInlineLimit: 0` in `web/vite.config.ts` so Vite never inlines small assets (card brand logos, icons) as base64. Prefer SVG imported as React components or files under `web/public/`.
- **No inline `<style>` or `<script>`:** use CSS Modules or plain CSS files; no CSS-in-JS libraries that inject `<style>` tags (styled-components, emotion). The React `style` prop is allowed (applied through the CSSOM).
- **Fonts self-hosted** (bundled `woff2`) or system font stack; no font CDN.
- `index.html` keeps only external `<script type="module" src>` and `<link rel="stylesheet">`.
- A build test checks `web/dist` (all `.html`, `.css`, `.js`) contains no `data:image` or inline `<script>`/`<style>` content.
