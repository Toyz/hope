// Registries — the dedicated system page for private-registry credentials. hope
// is the fleet's registry authority: creds added here apply to the local daemon
// and every connected agent, and (with a state db) persist on the PRIMARY hope
// node. The same manager is also reachable as a quick-add modal from the images
// page; both host the shared <hope-registries> component. The page adds the header
// chrome + an "add registry" action that opens the component's add dialog.
import { LoomElement, component, styles, css, mount, query, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import type { HopeRegistries } from "../components/registries";
import { theme } from "../styles";

@route("/registries")
@component("hope-registries-page")
@styles(theme, css`
  :host { display: block; min-height: 100%; background: var(--ink); }
`)
export class RegistriesPage extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @query("hope-registries") accessor regEl!: HopeRegistries;

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) app.get(LoomRouter).navigate("/login");
  }

  update() {
    return (
      <>
        <hope-phead heading="Registries" scope="primary" meta="private image pull credentials · applied to the local daemon and every agent">
          <hope-button slot="actions" icon="plus" onClick={() => this.regEl?.openAdd()}>add registry</hope-button>
        </hope-phead>
        <hope-registries></hope-registries>
      </>
    );
  }
}
