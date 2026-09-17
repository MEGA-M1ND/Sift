import { defineConfig } from "vite";
import { crx, defineManifest } from "@crxjs/vite-plugin";

const manifest = defineManifest({
  manifest_version: 3,
  name: "Sift",
  description:
    "Score every Amazon review against a plain-English filter and surface the ones that matter.",
  version: "0.1.0",
  permissions: ["storage"],
  // The API client lives in the service worker; this is what lets it fetch
  // api.typesafe.ai without a CORS preflight problem.
  host_permissions: ["https://api.typesafe.ai/*"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      // Host-level matches, because an Amazon product URL carries a slug before
      // /dp/ and path patterns cannot express that. detectPage() is the real
      // gate: on any page it does not recognise, the content script does
      // nothing at all.
      matches: ["https://*.amazon.in/*", "https://*.amazon.com/*"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  options_page: "src/options/index.html",
  action: { default_title: "Sift" },
});

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { options: "src/options/index.html" },
    },
  },
});
