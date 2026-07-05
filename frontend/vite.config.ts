import { defineConfig } from "vite";

// Build-time version stamp: CI/CD sets HOPE_VERSION to the short commit sha (e.g.
// `git rev-parse --short HEAD`); local/dev builds fall back to "dev". Inlined as
// __HOPE_VERSION__ so the UI shows the exact build, no semver to maintain.
const VERSION = process.env.HOPE_VERSION || "dev";

// hope frontend build. Outputs to dist/, which the Go binary embeds via
// go:embed all:frontend/dist. In dev, proxy /rpc (and the /rpc/Stream/*
// NDJSON routes underneath it) to the local backend.
export default defineConfig({
  define: {
    __HOPE_VERSION__: JSON.stringify(VERSION),
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "@toyz/loom",
    target: "es2022",
    keepNames: true,
  },
  server: {
    proxy: {
      "/rpc": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    dedupe: ["@toyz/loom"],
  },
});
