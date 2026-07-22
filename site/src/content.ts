// The docs content, as data. One block model rendered by <hope-doc>, one NAV tree
// driving the rail. Editing docs = editing this file; no per-page components.

export type Block =
  | { t: "h"; text: string; level?: 2 | 3 }
  | { t: "p"; text: string } // inline: `code`, **bold**, [text](href)
  | { t: "code"; lang?: string; code: string }
  | { t: "note"; tone?: "info" | "ok" | "warn"; text: string }
  | { t: "list"; items: string[] }
  | { t: "kv"; rows: [string, string][] };

export interface DocPage {
  title: string;
  lead?: string; // one-line subtitle under the page heading
  blocks: Block[];
}

export interface NavItem { slug: string; title: string }
export interface NavSection { section: string; items: NavItem[] }

export const NAV: NavSection[] = [
  { section: "start", items: [
    { slug: "overview", title: "overview" },
    { slug: "getting-started", title: "getting started" },
  ] },
  { section: "fleet", items: [
    { slug: "agents", title: "agents" },
    { slug: "stacks", title: "stacks & containers" },
    { slug: "audit", title: "audit" },
  ] },
  { section: "plugins", items: [
    { slug: "plugins", title: "plugin engine" },
    { slug: "dynamic-forms", title: "dynamic forms" },
  ] },
  { section: "networking", items: [
    { slug: "tunnels", title: "tunnels" },
    { slug: "registries", title: "registries" },
  ] },
  { section: "interfaces", items: [
    { slug: "api", title: "api" },
    { slug: "mcp", title: "mcp gateway" },
  ] },
];

export const HOME = "overview";

export const PAGES: Record<string, DocPage> = {
  overview: {
    title: "hope",
    lead: "A self-hosted control plane for your Docker fleet — one operator UI over every host, no agent lock-in, no bespoke state.",
    blocks: [
      { t: "p", text: "hope talks to Docker directly. It reads the daemon's own labels and state, so a stack hope manages is just a stack — `docker compose` sees it, another tool sees it, hope sees it. There's no hope-only database of truth to drift out of sync. Point it at a socket and it works." },
      { t: "note", tone: "info", text: "Yes — these docs are hope's actual UI chrome. The rail, the panels, the type, the palette of exactly-three colors. If the docs look like the app, that's the point." },
      { t: "h", text: "What it does", level: 2 },
      { t: "list", items: [
        "**Fleet** — one UI over the local daemon and any number of remote hosts, each connected by a lightweight agent over a single tunnel.",
        "**Stacks & containers** — start / stop / restart / redeploy / pull, live logs and stats, inline spec edits, all API-only (no compose files required).",
        "**Plugins** — extend hope with a container that speaks a small JSON-RPC protocol; hope renders its UI, no plugin JavaScript.",
        "**Tunnels** — publish a service through Cloudflare in a couple of clicks; hope manages the connector.",
        "**Audit** — a fleet-wide who/what/where/when trail across every operation and plugin action.",
      ] },
      { t: "h", text: "The thesis", level: 2 },
      { t: "p", text: "Own the interface, not the state. hope compiles intent onto the tools already there — the Docker API, compose labels, Cloudflare — instead of standing up its own orchestrator you have to feed and re-learn. It's a zero-trust MOSA: a modular open system where every capability a plugin gets is an explicit, consented, least-privilege grant." },
    ],
  },

  "getting-started": {
    title: "getting started",
    lead: "Run hope against a Docker socket. That's the whole install.",
    blocks: [
      { t: "h", text: "Run it", level: 2 },
      { t: "code", lang: "bash", code: "docker run -d --name hope \\\n  -p 8080:8080 \\\n  -v /var/run/docker.sock:/var/run/docker.sock \\\n  -v hope-data:/data \\\n  ghcr.io/toyz/hope:latest" },
      { t: "p", text: "Open `http://localhost:8080`. hope reads the mounted socket and shows every stack + container on that daemon. The `/data` volume holds the state db — agent roster, registry creds (encrypted), plugin approvals, favorites, the audit log. Skip it and hope runs stateless (nothing persists across a recreate)." },
      { t: "note", tone: "warn", text: "The socket is root-equivalent over that host. Run hope where you'd run a Docker admin tool, and set an `[auth]` token so the UI + API require a bearer." },
      { t: "h", text: "Add hosts", level: 2 },
      { t: "p", text: "Set an `[agent]` token, then run a `hope-agent` on each remote host pointing back at hope. It dials in over one WebSocket (rides 443 through Cloudflare if you like), and that host joins the fleet switcher. See [agents](#/agents)." },
    ],
  },

  agents: {
    title: "agents",
    lead: "One hope, many hosts — each connected by a lightweight agent over a single tunnel.",
    blocks: [
      { t: "p", text: "hope manages the local daemon out of the box. To manage a remote host, run a `hope-agent` there: it dials back to hope over a WebSocket and relays that host's Docker API through the tunnel. No inbound ports on the remote — the agent connects out." },
      { t: "code", lang: "bash", code: "docker run -d --name hope-agent --restart unless-stopped \\\n  -v /var/run/docker.sock:/var/run/docker.sock \\\n  ghcr.io/toyz/hope-agent:latest \\\n  --hope wss://hope.example.com/agent/connect \\\n  --token <AGENT_TOKEN>" },
      { t: "p", text: "The host appears in the host switcher the moment it connects. Every RPC hope makes is host-scoped: the transport carries the active host, and the agent hub routes it to the right daemon. Registry creds, plugin dialing, and tunnels all work across agents transparently." },
      { t: "kv", rows: [
        ["connection", "agent → hope, outbound WebSocket (rides 443 via Cloudflare)"],
        ["auth", "a shared [agent] token; the agent proves it on connect"],
        ["roster", "persisted in the state db, so a reconnecting host is recognized"],
      ] },
    ],
  },

  stacks: {
    title: "stacks & containers",
    lead: "Lifecycle over the Docker API — no compose files required.",
    blocks: [
      { t: "p", text: "hope groups containers into stacks by compose project label and drives their lifecycle straight through the Docker API: start, stop, restart, pull, redeploy (`compose up -d --force-recreate` without the file). It works over a remote daemon or a socket proxy, and without mounting the host's project directories." },
      { t: "list", items: [
        "**Redeploy** — pull the latest image and recreate on it, preserving config / networks / labels.",
        "**Inline spec edit** — change env, ports, mounts, labels in the UI; hope re-applies the stored spec.",
        "**Live logs + stats** — multi-source log viewer, point-in-time CPU/mem snapshots.",
        "**Update flags** — hope checks each image against its registry (manifest lookup, no pull) and marks what's outdated.",
      ] },
      { t: "note", tone: "info", text: "Everything is a real Docker operation. hope never hides state from the daemon — `docker ps` always agrees with the rail." },
    ],
  },

  audit: {
    title: "audit",
    lead: "A fleet-wide who / what / where / when trail across every operation and plugin action.",
    blocks: [
      { t: "p", text: "One reusable audit engine records every mutation through hope — container lifecycle, stack ops, image/volume/network changes, and plugin actions — with the actor, the source, the stack it came from, the host, whether it worked, and how long it took. It's sealed at rest in the state db and queryable fleet-wide." },
      { t: "h", text: "What a record carries", level: 2 },
      { t: "kv", rows: [
        ["actor", "the authenticated subject, or plugin:<identity> for a plugin action"],
        ["source", "operator · plugin · system"],
        ["category", "container · stack · image · volume · network · tunnel · plugin · agent"],
        ["action", "restart · redeploy · remove · enable · …"],
        ["stack + host", "where it came from — mission-critical provenance"],
        ["result", "ok / failed + error + duration"],
        ["meta", "optional structured extra data, shown in the row flyout"],
      ] },
      { t: "h", text: "Zero-trust attribution", level: 2 },
      { t: "p", text: "A plugin never writes audit entries itself. hope records them — the actor comes from the authenticated session, the timing from hope's own clock, the host from hope's routing. A plugin only contributes the action name and a destructive flag. So the log answers who-did-what un-spoofably, which is the whole point of an audit trail." },
      { t: "note", tone: "ok", text: "The audit page is a system page in hope's rail: filter by category, scan the hairline table, click a row for the full detail + metadata flyout." },
    ],
  },

  plugins: {
    title: "plugin engine",
    lead: "Extend hope with a container that speaks a small JSON-RPC protocol. hope renders its UI — no plugin JavaScript.",
    blocks: [
      { t: "p", text: "A plugin is your container, your language, your endpoint. It exposes `hope.schema` (what views/actions/streams it has) and `hope.layout` (where they render). hope dials it, fetches the schema, and draws the whole UI from data — tables, forms, charts, streams, full pages in the rail. The plugin ships zero frontend code." },
      { t: "code", lang: "go", code: "p := plugin.New(\"badge-directory\", \"1.0.0\").Icon(\"database\")\np.View(\"counts\", \"Counts\", plugin.KV, func(ctx context.Context) (any, error) {\n    return map[string]any{\"users\": 1402301, \"badges\": 88123}, nil\n})\nlog.Fatal(p.ListenAndServe(\":8080\")) // JSON-RPC 2.0 at /__hope" },
      { t: "p", text: "The container declares the labels hope scans for (`hope.plugin=true`, `hope.plugin.port=8080`), and hope discovers it across the fleet." },
      { t: "h", text: "Explicit trust", level: 2 },
      { t: "p", text: "Nothing is automatic. hope shows a consent screen listing every reverse-channel capability a plugin requests — subscribe to events, publish, storage, mutate — and the operator approves a subset. Grants are sealed server-side and bound to the plugin's stable identity; a plugin can't self-escalate, and an image swap that grows its permissions forces re-consent." },
      { t: "h", text: "Layered health", level: 2 },
      { t: "p", text: "hope owns liveness — whether the plugin is reachable at all, un-spoofable via the dial. The plugin reports its own advisory status on top (`{status, level, detail}`), which hope colors but never trusts for liveness. Unreachable plugins render as degraded from a last-good cache instead of vanishing." },
      { t: "note", tone: "info", text: "The reference plugin, kitchen-sink, exercises every surface at once and is installable in one click from the marketplace." },
    ],
  },

  "dynamic-forms": {
    title: "dynamic forms",
    lead: "Plugin forms that talk back: RPC-populated selects, a selection that resolves to a live surface, and repeatable groups.",
    blocks: [
      { t: "p", text: "The plugin action model started as a static `Action{method, fields}`. Dynamic forms make it talk back to the plugin as the operator fills it in — still data-driven, still no plugin JS." },
      { t: "h", text: "RPC-populated options", level: 2 },
      { t: "p", text: "A select declares `optionsMethod`; hope fetches its choices from the plugin live as it renders the form, instead of a hard-coded list." },
      { t: "code", lang: "go", code: "p.Options(\"commandList\", func(ctx context.Context) ([]plugin.Option, error) {\n    return []plugin.Option{{Label: \"Restart workers\", Value: \"restart\"}}, nil\n})" },
      { t: "h", text: "Selector → surface", level: 2 },
      { t: "p", text: "A field declares `resolveMethod`; on change, hope calls it with the current values and the plugin returns a **surface** — a form, a preview, a confirmation, a result — which hope renders inline, using the same renderer that draws every other plugin panel. Pick a command, see what it'll do." },
      { t: "h", text: "Repeatable groups", level: 2 },
      { t: "p", text: "A `group` field is an array-of-objects the operator adds/removes rows of — a forms-builder. The action receives an array of objects. Tag N services, run N commands, in one submit." },
    ],
  },

  tunnels: {
    title: "tunnels",
    lead: "Publish a service through Cloudflare in a couple of clicks. hope manages the connector.",
    blocks: [
      { t: "p", text: "hope integrates with Cloudflare Tunnel: pick a service, pick a hostname, and hope creates the route and manages the `cloudflared` connector for you. No inbound ports, no reverse proxy to hand-configure — the connector dials out to Cloudflare's edge." },
      { t: "list", items: [
        "**Per-service routes** — map `app.example.com` to a container:port; hope wires it.",
        "**Connector lifecycle** — hope creates, names, and operates the connector container.",
        "**Fleet-aware** — a service on any agent host tunnels the same way; hope routes it.",
      ] },
      { t: "note", tone: "info", text: "Because it's a real Cloudflare tunnel, your existing Access policies, WAF, and DNS all apply — hope just automates the plumbing." },
    ],
  },

  registries: {
    title: "registries",
    lead: "hope is the fleet's registry-auth authority.",
    blocks: [
      { t: "p", text: "Add private-registry credentials once in hope and they apply to the local daemon AND every connected agent — including agents that connect later. Creds added in the UI are stored encrypted in the state db on the primary node; config-file creds and UI creds merge." },
      { t: "kv", rows: [
        ["scope", "local daemon + every agent, current and future"],
        ["storage", "encrypted with the token secret in the state db"],
        ["use", "image pulls, redeploys, and update checks across the fleet"],
      ] },
    ],
  },

  api: {
    title: "api",
    lead: "Everything the UI does is an RPC. The API is the same surface, keyed.",
    blocks: [
      { t: "p", text: "hope's UI is a thin client over a JSON-RPC API (built on sov). Set one or more long random keys in the config and every route requires a bearer — the same keys drive the UI login and programmatic access. A key is root-equivalent over every host hope manages, so keep it secret." },
      { t: "code", lang: "bash", code: "curl -s https://hope.example.com/rpc \\\n  -H \"Authorization: Bearer $HOPE_KEY\" \\\n  -H \"X-Hope-Host: prod-1\" \\\n  -d '{\"method\":\"Stacks.List\",\"params\":[]}'" },
      { t: "p", text: "The host is ambient: the transport carries the active host (a header), so you never thread it per call — one API, every host. Reads, mutations, and NDJSON streams (logs, live ops) all ride the same endpoint." },
    ],
  },

  mcp: {
    title: "mcp gateway",
    lead: "Fleet control as MCP tools — AI-native, gated by the same consent model.",
    blocks: [
      { t: "p", text: "hope exposes its control plane as MCP tools, so an AI agent can inspect and operate the fleet the same way an operator does through the UI — read stacks, tail logs, redeploy, all through hope's authorization. The gateway owns nothing itself: plugins expose MCP tools, and hope discovers, namespaces, routes, and gates them fleet-wide over the agent tunnel." },
      { t: "note", tone: "info", text: "Every AI-driven action flows through the same audit + consent model as a human operator. No side door." },
    ],
  },
};
