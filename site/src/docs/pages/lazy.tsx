import { LoomElement, component } from "@toyz/loom";
import { lazy } from "@toyz/loom/element";
import { route } from "@toyz/loom/router";
import { searchable } from "../search-registry";

@route("/")
@route("/overview")
@component("hope-page-overview")
@lazy(() => import("./overview"))
@searchable({
  title: "Overview",
  section: "Start",
  to: "/overview",
  keywords: ["docker", "fleet", "control plane", "self hosted"],
  summary: "What hope is and why operators use it.",
})
class LazyOverview extends LoomElement {}

@route("/getting-started")
@component("hope-page-getting-started")
@lazy(() => import("./getting-started"))
@searchable({
  title: "Getting Started",
  section: "Start",
  to: "/getting-started",
  keywords: ["install", "docker run", "setup"],
  summary: "Launch, secure, and verify hope.",
})
class LazyGettingStarted extends LoomElement {}

@route("/configuration")
@component("hope-page-configuration")
@lazy(() => import("./configuration"))
@searchable({
  title: "Configuration",
  section: "Start",
  to: "/configuration",
  keywords: ["toml", "auth", "docker", "store", "environment"],
  summary: "Configure security, persistence, hosts, plugins, and tunnels.",
})
class LazyConfiguration extends LoomElement {}

@route("/fleet")
@component("hope-page-fleet")
@lazy(() => import("./fleet"))
@searchable({
  title: "Fleet Overview",
  section: "Fleet",
  to: "/fleet",
  keywords: ["dashboard", "hosts", "topology", "health", "mission control"],
  summary:
    "Operate local and remote Docker hosts through one explicit fleet context.",
})
class LazyFleet extends LoomElement {}

@route("/agents")
@component("hope-page-agents")
@lazy(() => import("./agents"))
@searchable({
  title: "Agents",
  section: "Fleet",
  to: "/agents",
  keywords: ["remote", "websocket", "host", "enroll"],
  summary: "Connect remote Docker hosts over outbound agent tunnels.",
})
class LazyAgents extends LoomElement {}

@route("/stacks")
@component("hope-page-stacks")
@lazy(() => import("./stacks"))
@searchable({
  title: "Stacks & Containers",
  section: "Fleet",
  to: "/stacks",
  keywords: ["compose", "lifecycle", "redeploy", "logs"],
  summary: "Operate Docker stacks, services, and containers.",
})
class LazyStacks extends LoomElement {}

@route("/images")
@component("hope-page-images")
@lazy(() => import("./images"))
@searchable({
  title: "Images",
  section: "Fleet",
  to: "/images",
  keywords: ["disk", "prune", "dangling", "unused", "remove", "inventory"],
  summary: "Inspect fleet image usage and reclaim disk with workload context.",
})
class LazyImages extends LoomElement {}

@route("/updates")
@component("hope-page-updates")
@lazy(() => import("./updates"))
@searchable({
  title: "Updates & Freshness",
  section: "Fleet",
  to: "/updates",
  keywords: ["digest", "image", "registry", "stale"],
  summary: "Detect stale images and roll them out intentionally.",
})
class LazyUpdates extends LoomElement {}

@route("/audit")
@component("hope-page-audit")
@lazy(() => import("./audit"))
@searchable({
  title: "Audit",
  section: "Fleet",
  to: "/audit",
  keywords: ["operator", "plugin", "mutation", "history"],
  summary: "Trace mutations, provenance, outcomes, and latency.",
})
class LazyAudit extends LoomElement {}

@route("/plugins")
@component("hope-page-plugins")
@lazy(() => import("./plugins"))
@searchable({
  title: "Plugin Engine",
  section: "Plugins",
  to: "/plugins",
  keywords: ["views", "actions", "streams", "permissions", "surfaces"],
  summary: "Extend hope through container-native, explicitly trusted plugins.",
})
class LazyPlugins extends LoomElement {}

@route("/plugin-getting-started")
@component("hope-page-plugin-getting-started")
@lazy(() => import("./plugin-getting-started"))
@searchable({
  title: "Plugin Getting Started",
  section: "Plugins",
  to: "/plugin-getting-started",
  keywords: ["sdk", "labels", "schema", "enable"],
  summary: "Build and enable a first plugin container.",
})
class LazyPluginGettingStarted extends LoomElement {}

@route("/plugins/trust")
@component("hope-page-plugin-trust")
@lazy(() => import("./plugin-trust"))
@searchable({
  title: "Plugin Discovery & Trust",
  section: "Plugins",
  to: "/plugins/trust",
  keywords: ["discovery", "approval", "fingerprint", "token", "permissions"],
  summary:
    "Understand discovery, schema approval, tokens, and reverse capability grants.",
})
class LazyPluginTrust extends LoomElement {}

@route("/plugins/surfaces")
@component("hope-page-plugin-surfaces")
@lazy(() => import("./plugin-surfaces"))
@searchable({
  title: "Plugin Surfaces & Pages",
  section: "Plugins",
  to: "/plugins/surfaces",
  keywords: ["container", "stack", "dashboard", "page", "navigation", "detail"],
  summary:
    "Mount integrations in container, stack, dashboard, and full-page contexts.",
})
class LazyPluginSurfaces extends LoomElement {}

@route("/plugins/views")
@component("hope-page-plugin-views")
@lazy(() => import("./plugin-views"))
@searchable({
  title: "Plugin Views & Cells",
  section: "Plugins",
  to: "/plugins/views",
  keywords: ["table", "query", "tree", "chart", "cards", "stat", "cells"],
  summary:
    "Return structured data through Hope's built-in views and rich cells.",
})
class LazyPluginViews extends LoomElement {}

@route("/plugins/components")
@component("hope-page-plugin-components")
@lazy(() => import("./plugin-components"))
@searchable({
  title: "Plugin Components",
  section: "Plugins",
  to: "/plugins/components",
  keywords: [
    "box",
    "stack",
    "row",
    "grid",
    "heading",
    "sparkline",
    "component",
  ],
  summary:
    "Compose safe custom layouts from Hope-rendered component primitives.",
})
class LazyPluginComponents extends LoomElement {}

@route("/dynamic-forms")
@component("hope-page-dynamic-forms")
@lazy(() => import("./dynamic-forms"))
@searchable({
  title: "Dynamic Forms",
  section: "Plugins",
  to: "/dynamic-forms",
  keywords: ["fields", "options", "resolve", "groups"],
  summary: "Build plugin actions whose fields respond to live context.",
})
class LazyDynamicForms extends LoomElement {}

@route("/plugins/streams")
@component("hope-page-plugin-streams")
@lazy(() => import("./plugin-streams"))
@searchable({
  title: "Plugin Streams & Events",
  section: "Plugins",
  to: "/plugins/streams",
  keywords: ["counter", "log", "series", "ndjson", "events", "alerts"],
  summary:
    "Push live frames, handle cancellation, and integrate with fleet events.",
})
class LazyPluginStreams extends LoomElement {}

@route("/networking")
@component("hope-page-networking")
@lazy(() => import("./networking"))
@searchable({
  title: "Networking Overview",
  section: "Networking",
  to: "/networking",
  keywords: ["agents", "websocket", "registry", "cloudflare", "socket proxy"],
  summary: "Separate Hope's control, image, and public service traffic planes.",
})
class LazyNetworking extends LoomElement {}

@route("/tunnels")
@component("hope-page-tunnels")
@lazy(() => import("./tunnels"))
@searchable({
  title: "Tunnels",
  section: "Networking",
  to: "/tunnels",
  keywords: ["cloudflare", "connector", "hostname", "route"],
  summary: "Map public hostnames and paths to fleet services.",
})
class LazyTunnels extends LoomElement {}

@route("/registries")
@component("hope-page-registries")
@lazy(() => import("./registries"))
@searchable({
  title: "Registries",
  section: "Networking",
  to: "/registries",
  keywords: ["credentials", "images", "pull", "private"],
  summary: "Manage private registry credentials across the fleet.",
})
class LazyRegistries extends LoomElement {}

@route("/interfaces")
@component("hope-page-interfaces")
@lazy(() => import("./interfaces"))
@searchable({
  title: "Interfaces Overview",
  section: "Interfaces",
  to: "/interfaces",
  keywords: ["browser", "rpc", "ndjson", "automation", "plugins"],
  summary:
    "Choose the browser, RPC, streaming, or plugin boundary for each integration.",
})
class LazyInterfaces extends LoomElement {}

@route("/api")
@component("hope-page-api")
@lazy(() => import("./api"))
@searchable({
  title: "API",
  section: "Interfaces",
  to: "/api",
  keywords: ["rpc", "automation", "api key", "introspect"],
  summary: "Automate hope through the same typed RPC surface as the UI.",
})
class LazyApi extends LoomElement {}
