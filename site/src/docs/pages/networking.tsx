import { LoomElement } from "@toyz/loom";

export default class NetworkingPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="networking"
          lead="Connect control paths, private image sources, and public service ingress without collapsing those distinct trust boundaries into one network."
        ></hope-doc-header>
        <section>
          <h2>Three traffic planes</h2>
          <div class="body">
            <dl class="facts">
              <dt>control plane</dt>
              <dd>
                Browser and API clients reach Hope; remote agents dial outward
                over WebSocket or trusted-LAN TCP.
              </dd>
              <dt>image plane</dt>
              <dd>
                Hope and agents authenticate to registries for manifest checks,
                pulls, and redeploys.
              </dd>
              <dt>service plane</dt>
              <dd>
                Cloudflare connectors carry public traffic from managed ingress
                rules to selected internal service ports.
              </dd>
            </dl>
            <p>
              Keeping those planes explicit makes failures easier to classify:
              an offline agent, a registry authentication error, and a broken
              public route do not present as the same generic networking
              problem.
            </p>
          </div>
        </section>
        <section>
          <h2>Remote host connectivity</h2>
          <div class="body">
            <ul>
              <li>
                Prefer outbound agents when a remote daemon should not accept
                inbound administration traffic.
              </li>
              <li>
                Use the WebSocket path through an authenticated edge when
                standard port 443 traversal matters.
              </li>
              <li>
                Use the optional raw TCP listener only on a trusted LAN or
                overlay network.
              </li>
              <li>
                Keep host identity explicit so requests and audit records retain
                their target across the tunnel.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Constrained Docker access</h2>
          <div class="body">
            <p>
              The optional socket proxy starts read-only with method and path
              allowlists for daemon discovery endpoints. It can provide selected
              Docker API visibility to a trusted network without exposing the
              raw socket, but every allowlist expansion increases authority.
            </p>
          </div>
        </section>
        <hope-doc-note tone="warn">
          Hope does not provide TLS termination. Put its HTTP surface behind a
          trusted reverse proxy or authenticated edge when leaving a private
          network.
        </hope-doc-note>
      </div>
    );
  }
}
