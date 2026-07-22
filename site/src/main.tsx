// hope-docs entrypoint. Registers the shell component and starts loom. No DI, no
// transport — it's a static docs SPA; the "rail" is content nav, not a live fleet.
import { app } from "@toyz/loom";
import "./app"; // registers <hope-docs>

app.start();
