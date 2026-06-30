import { defineConfig } from "vite";

// hope frontend build. Outputs to dist/, which the Go binary embeds via
// go:embed all:frontend/dist. In dev, proxy /rpc (and the /rpc/Stream/*
// NDJSON routes underneath it) to the local backend.
export default defineConfig({
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
