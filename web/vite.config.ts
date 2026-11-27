import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite is used only as the bundler. Output file names keep Vite's default
// content hash (for example `assets/index-<hash>.js`), which the deployment
// relies on for long-lived caching. Only `VITE_*` variables are exposed to the
// bundle through `import.meta.env`; no custom `define` is set here.
export default defineConfig({
  plugins: [react()],
  build: {
    // Never inline assets as data: URIs, so the CSP img-src 'self' stays valid.
    assetsInlineLimit: 0,
  },
});
