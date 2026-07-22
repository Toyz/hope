// hope-docs entrypoint. Registers the shell component and starts loom. No DI, no
// transport — it's a static docs SPA; the "rail" is content nav, not a live fleet.
import { app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";
import "./app"; // registers <hope-docs>
import "./docs/components/code-block";
import "./docs/components/doc-header";
import "./docs/components/doc-note";
import "./docs/pages/lazy";
import "./docs/pages/not-found";
import "./icons";

app.use(new LoomRouter({ mode: "hash" }));
app.start();
