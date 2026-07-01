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

import "./icons";
import "./components/confirm-modal"; // tiny stub; the real modal chunk is @lazy
import "./components/prompt-modal"; // reusable input dialog (<hope-prompt>)
import "./components/select"; // reusable custom dropdown (<hope-select>)
import "./components/toast-host"; // shared transient toasts (<hope-toast>)
import "./components/proc-dialog"; // shared processing dialog (<hope-proc>)
import "./components/host-switch"; // active Docker host picker (<hope-host-switch>)
import "./components/nav"; // shared system nav strip (<hope-nav>)
import "./components/footer"; // site footer with API + source links (<hope-footer>)
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
      if (res?.token) auth.set(res.token);
    } catch {
      /* not behind Access — fall back to the login form */
    }
  }
  app.start();
}
boot();
