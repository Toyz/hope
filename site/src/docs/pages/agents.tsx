import { LoomElement } from "@toyz/loom";

export default class AgentsPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="agents"
          lead="Turn isolated Docker hosts into one operational fleet without exposing a Docker API or opening an inbound management port on every machine."
        ></hope-doc-header>
        <section>
          <h2>One fleet, outbound by default</h2>
          <div class="body">
            <p>
              An agent runs beside a remote Docker daemon and opens an outbound
              WebSocket to hope. The browser continues to talk only to the
              control plane; hope targets the enrolled host and forwards typed
              operations over the existing connection.
            </p>
            <dl class="facts">
              <dt>direction</dt>
              <dd>
                Outbound WebSocket on the main HTTP path, or a raw TCP listener
                on trusted networks.
              </dd>
              <dt>host identity</dt>
              <dd>
                A stable operator-chosen ID carried through fleet views, RPC
                calls, events, and audit records.
              </dd>
              <dt>daemon scope</dt>
              <dd>
                The Docker or Podman endpoint available to that agent;
                credentials do not move into the browser.
              </dd>
              <dt>fleet signal</dt>
              <dd>
                Connectivity, version, platform, daemon details, resources,
                workload state, and last-seen time.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>What changes for the operator</h2>
          <div class="body">
            <ul>
              <li>
                Compare stack and update health across hosts from one dashboard
                instead of maintaining a tab or SSH session per machine.
              </li>
              <li>
                Open a remote stack, follow logs, inspect resources, and run the
                same lifecycle actions used for the local daemon.
              </li>
              <li>
                Keep host targeting explicit in automation with the
                <code>X-Hope-Host</code> header.
              </li>
              <li>
                Separate control-plane reachability from workload health: an
                offline agent and a failed container are different incidents.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Enrollment runbook</h2>
          <div class="body">
            <ol>
              <li>
                Set a strong shared enrollment token and choose WebSocket or
                trusted-LAN TCP transport.
              </li>
              <li>
                Run the agent beside the target daemon with a stable host ID.
              </li>
              <li>
                Confirm the host reports platform, daemon, resource, and
                workload state in the fleet view.
              </li>
              <li>
                Exercise a low-risk read and restart workflow, then confirm host
                attribution in audit.
              </li>
              <li>
                Forget retired identities and rotate the shared token whenever
                enrollment access changes.
              </li>
            </ol>
          </div>
        </section>
        <hope-doc-note tone="warn">
          An enrollment token grants a path to root-equivalent Docker control.
          Treat it as an administrative secret, not a host label.
        </hope-doc-note>
      </div>
    );
  }
}
