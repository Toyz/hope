// hope frontend entrypoint: register DI services, the RPC transport, and the
// history-mode router; import the page modules so their @component/@route
// decorators run; then start.
import { app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";
import { RpcTransport } from "@toyz/loom-rpc";
import { AuthStore } from "./auth-store";
import { HopeTransport } from "./transport";
import { ConfirmService } from "./confirm";

import "./icons";
import "./components/confirm-modal"; // tiny stub; the real modal chunk is @lazy
import "./app";
import "./pages/login";
import "./pages/dashboard";
import "./pages/stack";
import "./pages/container";

app.use(AuthStore);
app.use(ConfirmService);

// Register the transport under both its concrete class (so components inject a
// typed HopeTransport, incl. streamWithSignal) and the abstract RpcTransport
// token (so loom-rpc internals resolve it).
const transport = new HopeTransport();
app.use(HopeTransport, transport);
app.use(RpcTransport, transport);

app.use(new LoomRouter({ mode: "history" }));

app.start();
