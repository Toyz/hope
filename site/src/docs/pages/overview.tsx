import { LoomElement } from "@toyz/loom";

export default class OverviewPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="hope"
          lead="Mission control for the Docker estate you already run: one fleet view, one operating loop, and no replacement scheduler."
        ></hope-doc-header>
        <section>
          <h2>When Docker works but operating it does not</h2>
          <div class="body">
            <p>
              Compose is a good deployment model for homes, labs, edge systems,
              and small infrastructure teams. The pain starts later: every host
              has its own dashboard, incidents become SSH sessions, image drift
              is invisible, and nobody can answer who restarted what.
            </p>
            <p>
              Hope adds the missing operating plane. It reads live Docker state,
              rebuilds the stack and service topology from Compose labels, and
              gives local and remote hosts one consistent control surface.
              Workloads remain ordinary Docker workloads throughout.
            </p>
          </div>
        </section>
        <section>
          <h2>The product in four loops</h2>
          <div class="body">
            <dl class="facts">
              <dt>observe</dt>
              <dd>
                Read a fleet verdict, attention signals, stack health, replicas,
                daemon capacity, disk use, and image freshness without opening
                each host.
              </dd>
              <dt>diagnose</dt>
              <dd>
                Move from a degraded service to container health, multiplexed
                logs, live CPU and memory, ports, mounts, networks, and exact
                image identity.
              </dd>
              <dt>operate</dt>
              <dd>
                Start, stop, restart, pull, redeploy, prune, and manage public
                routes through guarded Docker API operations.
              </dd>
              <dt>verify</dt>
              <dd>
                Watch live state recover, confirm the new digest, and retain
                actor, target, outcome, error context, and duration in audit
                history.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>What a normal incident looks like</h2>
          <div class="body">
            <ol>
              <li>
                The fleet ribbon lights up one stack while healthy workloads
                stay quiet.
              </li>
              <li>
                You open the service, compare replicas, and follow source-tagged
                logs across all of them.
              </li>
              <li>
                You inspect health, resource pressure, and the running image
                before choosing a restart or redeploy.
              </li>
              <li>
                Hope targets the exact daemon, streams operation progress, and
                refreshes current state.
              </li>
              <li>
                The audit trail records the authenticated actor, host, resource,
                result, and timing.
              </li>
            </ol>
            <p>
              Detection, diagnosis, action, and provenance stay attached to the
              same topology. That continuity is the product, not another list of
              Docker objects.
            </p>
          </div>
        </section>
        <section>
          <h2>Built for the fleet after host one</h2>
          <div class="body">
            <ul>
              <li>
                <strong>Outbound agents.</strong> Remote hosts dial Hope over
                WebSocket or trusted-LAN TCP, so their Docker APIs need no
                inbound exposure.
              </li>
              <li>
                <strong>Explicit targeting.</strong> UI actions, RPC calls,
                events, plugins, image operations, and audit records retain host
                identity.
              </li>
              <li>
                <strong>Central image authority.</strong> Registry credentials
                support private manifest checks, pulls, and redeploys across
                connected hosts.
              </li>
              <li>
                <strong>Fleet-wide cleanup.</strong> Compare image disk
                composition and prune dangling or unused state with workload
                context.
              </li>
              <li>
                <strong>Shared ingress.</strong> Map Cloudflare tunnel hostnames
                and paths to services selected from live fleet inventory.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Extension without a frontend fork</h2>
          <div class="body">
            <p>
              A container plugin can add matched inspector panels, fleet and
              stack widgets, full pages, structured actions, forms, live
              streams, rich tables, and safe component layouts. Hope proxies the
              wire protocol and renders the UI; the browser never connects
              directly to extension code.
            </p>
            <dl class="facts">
              <dt>discovered</dt>
              <dd>
                A labeled container advertises its schema but remains inactive.
              </dd>
              <dt>approved</dt>
              <dd>
                An operator reviews identity, UI contributions, and requested
                reverse capabilities.
              </dd>
              <dt>bounded</dt>
              <dd>
                Bearer identity, schema fingerprints, scope grants, call limits,
                stream limits, and sanitized icons constrain the integration.
              </dd>
              <dt>observable</dt>
              <dd>
                Plugin status, errors, latency, calls, and mutations remain
                visible inside Hope.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Choose Hope when</h2>
          <div class="body">
            <ul>
              <li>
                Your workloads already run well under Docker Compose or a
                Docker-compatible Podman API.
              </li>
              <li>
                You need one operational view across a handful or a fleet of
                hosts.
              </li>
              <li>
                You want Docker-native control without installing a Compose CLI
                into the control plane.
              </li>
              <li>
                You care about image drift, deliberate rollout, guarded
                destructive actions, and mutation provenance.
              </li>
              <li>
                You want domain integrations to feel native without granting
                arbitrary browser execution.
              </li>
            </ul>
            <h3>It is not trying to be</h3>
            <p>
              Hope is not a scheduler, an orchestrator replacement, a CI system,
              or a multi-tenant RBAC platform. It is an opinionated operating
              surface for trusted operators managing Docker infrastructure.
            </p>
          </div>
        </section>
        <section>
          <h2>Start with one host</h2>
          <div class="body">
            <p>
              A working deployment needs one config file, the Hope image, access
              to a Docker-compatible endpoint, and persistent storage. The first
              useful test is not merely reaching the login screen: discover a
              stack, follow logs, restart a non-critical service, and verify the
              audit entry.
            </p>
            <loom-link to="/getting-started">
              Run the first control loop →
            </loom-link>
          </div>
        </section>
        <hope-doc-note tone="warn">
          Docker control is root-equivalent. Hope is designed for a trusted
          operator boundary and should sit behind authentication and a private
          or authenticated network edge.
        </hope-doc-note>
      </div>
    );
  }
}
