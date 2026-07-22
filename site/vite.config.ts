import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

function latestPluginTag() {
  if (process.env.HOPE_PLUGIN_TAG) return process.env.HOPE_PLUGIN_TAG;
  try {
    return execFileSync(
      "git",
      ["tag", "--list", "plugin/v*", "--sort=-v:refname"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    ).trim().split("\n")[0] || "plugin/dev";
  } catch {
    return "plugin/dev";
  }
}

// hope-docs: a loom SPA that IS hope's chrome, hosting hope's docs. Built static and
// served from GitHub Pages. base defaults to the project-pages path (/hope/); override
// with DOCS_BASE for a custom domain ("/"). The router runs in hash mode so deep links
// work on Pages without server rewrites.
export default defineConfig({
  base: process.env.DOCS_BASE || "/hope/",
  define: {
    __HOPE_PLUGIN_TAG__: JSON.stringify(latestPluginTag()),
  },
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
