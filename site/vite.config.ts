import { defineConfig } from "vite";

// hope-docs: a loom SPA that IS hope's chrome, hosting hope's docs. Built static and
// served from GitHub Pages. base defaults to the project-pages path (/hope/); override
// with DOCS_BASE for a custom domain ("/"). The router runs in hash mode so deep links
// work on Pages without server rewrites.
export default defineConfig({
  base: process.env.DOCS_BASE || "/hope/",
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "@toyz/loom",
    target: "es2022",
    keepNames: true,
  },
  resolve: {
    dedupe: ["@toyz/loom"],
  },
});
