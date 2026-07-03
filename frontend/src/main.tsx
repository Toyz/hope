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
import { DeployIntent } from "./deploy-intent";
import { ImageDetailService } from "./components/image-detail";
import { NetworkDetailService } from "./components/network-detail";

import "./icons";
import "./components/confirm-modal"; // tiny stub; the real modal chunk is @lazy
import "./components/prompt-modal"; // reusable input dialog (<hope-prompt>)
import "./components/select"; // reusable custom dropdown (<hope-select>)
import "./components/toast-host"; // shared transient toasts (<hope-toast>)
import "./components/proc-dialog"; // shared processing dialog (<hope-proc>)
import "./components/host-switch"; // active Docker host picker (<hope-host-switch>)
import "./components/nav"; // shared system nav strip (<hope-nav>)
import "./components/footer"; // site footer with API + source links (<hope-footer>)
import "./components/image-detail"; // shared image-detail modal (<hope-image-detail>)
import "./components/kvlist"; // reusable key/value list for labels/options (<hope-kvlist>)
import "./components/kv-editor"; // shared key/value editor for options/labels (<hope-kv-editor>)
import "./components/panel"; // site-standard section card + header bar (<hope-panel>)
import "./components/alert"; // reusable inline banner (<hope-alert>)
import "./components/table"; // site-standard data table (<hope-table>)
import "./components/search"; // site-standard filter box (<hope-search>)
import "./components/chip"; // site-standard square label (<hope-chip>)
import "./components/button"; // site-standard action button (<hope-button>)
import "./components/refresh"; // shared bus-driven refresh control (<hope-refresh>)
import "./components/network-detail"; // shared network inspector modal (<hope-network-detail>)
import "./app";
import "./pages/login";
import "./pages/dashboard";
import "./pages/stack";
import "./pages/container";
import "./pages/deploy";
import "./pages/images";
import "./pages/networks";
import "./pages/volumes";
import "./pages/agents";
import "./pages/tunnels";
import "./pages/api-docs";

app.use(AuthStore);
app.use(ConfirmService);
app.use(ProcService);
app.use(PromptService);
app.use(ToastService);
app.use(HostContext);
app.use(DeployIntent);
app.use(ImageDetailService);
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
