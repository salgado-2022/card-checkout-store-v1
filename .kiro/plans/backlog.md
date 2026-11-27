# Backlog

Items that must become tasks in the spec named in each entry. Remove an entry once it exists in that spec's `tasks.md`.

## checkout-web
- [ ] **CSP-01 Production CSP compatibility.** Set `build.assetsInlineLimit: 0` in `web/vite.config.ts`; card brand logos and icons as SVG components or files in `web/public/`; CSS Modules or plain CSS only (no CSS-in-JS that injects `<style>`); self-hosted fonts or system stack. Add a Jest build test that scans `web/dist` for `data:image`, inline `<script>` and inline `<style>` and fails if any is found; run it in CI after `vite build`. Acceptance: deployed site shows the brand logo inside the card field and the browser console has zero CSP violations on all five screens. Rules: `.kiro/steering/frontend-ui.md` (CSP section).
