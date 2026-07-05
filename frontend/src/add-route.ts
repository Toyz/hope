// promptAddRoute — the one add-a-public-route flow (pick connector + hostname +
// port + path, then wire the tunnel ingress), shared by the stack page and the
// container inspector so the same dialog + mutation lives in one place instead of
// being copied per view. Targets a compose service (project+service) or a loose
// container id.
import type { HopeTransport } from "./transport";
import type { PromptService, PromptField } from "./prompt";
import type { ProcService } from "./proc";
import type { ToastService } from "./toast";
import { innerPort } from "./format";
import type { ConnectorView, ZoneView, OpResult } from "./contracts";

export interface RouteTarget {
  host: string;
  project?: string; // compose project (service target)
  service?: string; // compose service
  container?: string; // loose-container id (when there's no project/service)
  ports?: string[]; // published ports, to default the port field
  label?: string; // dialog subtitle + subdomain placeholder (service/container name)
  connectors?: ConnectorView[]; // prefetched, so the dialog opens instantly (no RPC on click)
  zones?: ZoneView[]; // prefetched zones
}

export interface RouteDeps {
  rpc: HopeTransport;
  prompt: PromptService;
  proc: ProcService;
  toast: ToastService;
}

// Prompt for + create a public route targeting a specific service/container.
// Returns true when a route was added (callers refresh on true).
export async function promptAddRoute(d: RouteDeps, t: RouteTarget): Promise<boolean> {
  // Use prefetched connectors/zones when the caller has them (so the dialog opens
  // with no network round-trip); fall back to fetching on demand.
  const [connectors, zones] = t.connectors
    ? [t.connectors, t.zones || []]
    : await Promise.all([
        d.rpc.callOn<ConnectorView[]>(t.host, "Tunnels", "connectors", []).catch(() => [] as ConnectorView[]),
        d.rpc.callOn<ZoneView[]>(t.host, "Tunnels", "zones", []).catch(() => [] as ZoneView[]),
      ]);
  if (!connectors.length) {
    d.toast.error("no connectors — deploy one on the Tunnels page");
    return false;
  }
  const haveZones = zones.length > 0;
  const def = connectors.find((c) => c.default) || connectors[0];
  const port = (t.ports || []).map(innerPort).find(Boolean) || "";
  const fields: PromptField[] = [
    { key: "connector", label: "connector", type: "select", value: def.id, options: connectors.map((c) => ({ value: c.id, label: (c.title || c.name) + (c.default ? " (shared)" : "") })) },
    { key: "port", label: "port", placeholder: "8080", value: port },
    ...(haveZones
      ? ([
          { key: "sub", label: "subdomain (blank = root domain)", optional: true, placeholder: t.label || "" },
          { key: "domain", label: "domain", type: "select", placeholder: "pick a domain", options: zones.map((z) => ({ value: z.name, label: z.name })) },
        ] as const)
      : ([{ key: "host_name", label: "hostname", placeholder: "app.example.com" }] as const)),
    { key: "path", label: "path (optional)", optional: true, placeholder: "/api" },
  ];
  const v = await d.prompt.ask({ title: `add route${t.label ? " · " + t.label : ""}`, icon: "link", message: "hope attaches the connector to the target's network, updates the tunnel ingress, and creates the DNS record.", submitLabel: "Add route", fields });
  if (!v) return false;
  const host = (haveZones ? (v.sub.trim() ? `${v.sub.trim()}.${v.domain}` : v.domain) : v.host_name).trim().toLowerCase();
  if (!host) {
    d.toast.error("hostname required");
    return false;
  }
  let ok = false;
  await d.proc.run(`add route ${host}`, async (emit) => {
    try {
      emit("attaching connector + updating ingress + DNS…");
      const res = await d.rpc.callOn<OpResult>(t.host, "Tunnels", "addTunnel", [host, v.port.trim(), v.connector, t.project || "", t.service || "", t.container || "", (v.path || "").trim()]);
      if (res && res.ok === false) {
        emit("failed: " + (res.error || "error"));
        return false;
      }
      emit(`route live -> https://${host}`);
      ok = true;
      return true;
    } catch (e: any) {
      emit("failed: " + (e?.message ?? "error"));
      return false;
    }
  });
  return ok;
}
