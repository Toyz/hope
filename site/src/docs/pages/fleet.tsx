import { LoomElement } from "@toyz/loom";

export default class FleetPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="fleet"
          lead="Operate local and remote Docker hosts as one topology while preserving explicit host identity on every read, action, event, and audit record."
        ></hope-doc-header>
        <section>
          <h2>The dashboard is an attention system</h2>
          <div class="body">
            <p>
              Hope compresses host and stack state into a fleet verdict, stack
              ribbon, update counts, and an attention zone. Healthy workloads
              stay quiet; degraded services, stale images, and unreachable hosts
              rise without hiding the rest of the estate.
            </p>
            <dl class="facts">
              <dt>fleet scope</dt>
              <dd>
                Compare every enrolled host and open a stack without changing
                control surfaces.
              </dd>
              <dt>host scope</dt>
              <dd>
                Focus health, resources, disk, updates, and plugin widgets on
                one daemon.
              </dd>
              <dt>topology rail</dt>
              <dd>
                Traverse host, stack, service, and container identity with live
                state markers.
              </dd>
              <dt>five-second loop</dt>
              <dd>
                Refresh daemon-backed state continuously while preserving an
                operator's current context.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>One operating model across hosts</h2>
          <div class="body">
            <ul>
              <li>
                Use a directly connected Docker or Podman endpoint for the
                primary host.
              </li>
              <li>
                Add remote daemons through outbound agents instead of publishing
                administrative sockets.
              </li>
              <li>
                Carry host identity through stack actions, image operations,
                update checks, tunnels, plugins, and RPC automation.
              </li>
              <li>
                Distinguish an offline control path from a degraded workload so
                the response matches the failure.
              </li>
              <li>
                Use plugin dashboard and stack widgets to bring domain signals
                into the same fleet context.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>From signal to verified recovery</h2>
          <div class="body">
            <ol>
              <li>
                Read the fleet verdict and open the host or stack carrying the
                attention signal.
              </li>
              <li>
                Inspect service replicas, container health, logs, stats, and
                image freshness.
              </li>
              <li>
                Take the narrowest useful lifecycle or image action against the
                explicit host.
              </li>
              <li>Watch events and current daemon state confirm recovery.</li>
              <li>
                Use audit history to verify actor, target, duration, and
                outcome.
              </li>
            </ol>
          </div>
        </section>
        <hope-doc-note>
          Hope centralizes operations, not scheduling. Each daemon remains the
          source of truth for its containers, images, networks, and volumes.
        </hope-doc-note>
      </div>
    );
  }
}
