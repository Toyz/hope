// hope frontend entrypoint: register DI services, the RPC transport, and the
// history-mode router; import the page modules so their @component/@route
// decorators run; then start.
import { app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";
import { RpcTransport } from "@toyz/loom-rpc";
import { AuthStore } from "./auth-store";
import { HopeTransport } from "./transport";
import { ConfirmService } from "./confirm";
import { ProcService } from "./proc";
import { PromptService } from "./prompt";
import { ToastService } from "./toast";
import { HostContext } from "./host-context";
import { Inspector } from "./inspector";
import { LogPanel } from "./log-panel";
import { ImageInspector } from "./image-inspector";
import { VolumeInspector } from "./volume-inspector";
import { NetworkInspector } from "./network-inspector";
import { ConnectorInspector } from "./connector-inspector";
import { PluginInspector } from "./plugin-inspector";
import { DeployIntent } from "./deploy-intent";
import { NetworkDetailService } from "./components/network-detail";

import "./icons";
import "./components/confirm-modal"; // tiny stub; the real modal chunk is @lazy
import "./components/prompt-modal"; // reusable input dialog (<hope-prompt>)
import "./components/select"; // reusable custom dropdown (<hope-select>)
import "./components/toast-host"; // shared transient toasts (<hope-toast>)
import "./components/proc-dialog"; // shared processing dialog (<hope-proc>)
import "./components/host-switch"; // active Docker host picker (<hope-host-switch>)
import "./components/rail"; // explorer scope-rail: the fleet tree (<hope-rail>)
import "./components/topbar"; // explorer top strip: breadcrumb + search + refresh (<hope-topbar>)
import "./components/inspector"; // docked container inspector (<hope-inspector>)
import "./components/logs"; // docked multi-source log viewer (<hope-logs>)
import "./components/registries"; // shared registry-credentials manager (<hope-registries>)
import "./components/image-inspector"; // docked image inspector (<hope-image-inspector>)
import "./components/volume-inspector"; // docked volume inspector (<hope-volume-inspector>)
import "./components/network-inspector"; // docked network inspector (<hope-network-inspector>)
import "./components/connector-inspector"; // docked connector inspector (<hope-connector-inspector>)
import "./components/plugin-inspector"; // docked plugin inspector (<hope-plugin-inspector>)
import "./components/plugin-surface"; // plugin UI renderer (<hope-plugin-surface>)
import "./components/sysbanner"; // global persistence warning above the shell (<hope-sysbanner>)
import "./components/tooltip"; // reusable hover tooltip (<hope-tip>)
import "./components/phead"; // shared page header: title row + stat band (<hope-phead>)
import "./components/stat"; // one labelled figure in a header stat band (<hope-stat>)
import "./components/skeleton"; // shimmer loading placeholder (<hope-skel>)
import "./components/palette"; // global ⌘K command palette (<hope-palette>)
import "./components/kvlist"; // reusable key/value list for labels/options (<hope-kvlist>)
import "./components/kv-editor"; // shared key/value editor for options/labels (<hope-kv-editor>)
import "./components/panel"; // site-standard section card + header bar (<hope-panel>)
import "./components/alert"; // reusable inline banner (<hope-alert>)
import "./components/search"; // site-standard filter box (<hope-search>)
import "./components/chip"; // site-standard square label (<hope-chip>)
import "./components/button"; // site-standard action button (<hope-button>)
import "./components/refresh"; // shared bus-driven refresh control (<hope-refresh>)
import "./components/network-detail"; // shared network inspector modal (<hope-network-detail>)
import "./app";
import "./host-boot"; // host-redirect catch-all (must load so the "*" route + guard register)
import "./pages/login";
import "./pages/dashboard";
import "./pages/stack";
import "./pages/deploy";
import "./pages/images";
import "./pages/networks";
import "./pages/volumes";
import "./pages/agents";
import "./pages/registries";
import "./pages/plugins";
import "./pages/plugin-page";
import "./pages/tunnels";
import "./pages/api-docs";

app.use(AuthStore);
app.use(ConfirmService);
app.use(ProcService);
app.use(PromptService);
app.use(ToastService);
app.use(HostContext);
app.use(Inspector);
app.use(LogPanel);
app.use(ImageInspector);
app.use(VolumeInspector);
app.use(NetworkInspector);
app.use(ConnectorInspector);
app.use(PluginInspector);
app.use(DeployIntent);
app.use(NetworkDetailService);

// Register the transport under both its concrete class (so components inject a
// typed HopeTransport, incl. streamWithSignal) and the abstract RpcTransport
// token (so loom-rpc internals resolve it).
const transport = new HopeTransport();
app.use(HopeTransport, transport);
app.use(RpcTransport, transport);

app.use(new LoomRouter({ mode: "history" }));

// Cloudflare Access SSO: if we arrived through Access (the edge added a valid
// assertion), exchange it for a hope session before first render — no login
// form. Off Access (LAN/ZeroTier) this 401s and the password login shows.
async function boot() {
  const auth = app.get(AuthStore);
  if (!auth.isAuthenticated) {
    try {
      const res = await transport.call<{ token: string }>("Auth", "sso", []);
      if (res?.token) auth.set(res.token, true); // Access SSO session
    } catch {
      /* not behind Access — fall back to the login form */
    }
  }
  app.start();
}
boot();
