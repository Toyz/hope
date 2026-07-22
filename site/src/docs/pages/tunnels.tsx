import { LoomElement } from "@toyz/loom";

export default class TunnelsPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="tunnels"
          lead="Publish a Docker service through an existing Cloudflare tunnel without losing track of which connector, host, stack, service, and port carry the route."
        ></hope-doc-header>
        <section>
          <h2>Connector model</h2>
          <div class="body">
            <p>
              hope tracks connector containers, their status and version, and
              the ingress routes assigned to each one. In fleet mode every
              operation retains its target host.
            </p>
            <p>
              Hope manages route intent and DNS through the Cloudflare API. It
              does not replace or launch <code>cloudflared</code>; a labeled
              connector container remains the data plane.
            </p>
          </div>
        </section>
        <section>
          <h2>Route model</h2>
          <div class="body">
            <dl class="facts">
              <dt>public side</dt>
              <dd>Domain, hostname, and optional path.</dd>
              <dt>service side</dt>
              <dd>
                Host, Compose project, service or container, and internal port.
              </dd>
              <dt>connector</dt>
              <dd>The cloudflared instance carrying the route.</dd>
              <dt>lifecycle</dt>
              <dd>
                Add, edit, move, and remove routes from the tunnel screen.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Publish a service</h2>
          <div class="body">
            <ol>
              <li>
                Run and label a cloudflared connector, then confirm Hope reports
                it healthy.
              </li>
              <li>Select the public hostname and optional path to publish.</li>
              <li>
                Choose the target host, Compose project, service, and internal
                port from live fleet inventory.
              </li>
              <li>
                Assign the connector and apply the route so Hope updates ingress
                and the DNS CNAME.
              </li>
              <li>
                Verify external traffic, then keep connector and route health
                visible beside workload state.
              </li>
            </ol>
          </div>
        </section>
        <hope-doc-note>
          Changing an ingress route affects public traffic. Verify the selected
          host, connector, service, and internal port before applying it.
        </hope-doc-note>
      </div>
    );
  }
}
