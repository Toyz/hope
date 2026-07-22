import { LoomElement } from "@toyz/loom";

export default class StacksPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="stacks & containers"
          lead="See Compose workloads as operators think about them, then move from a fleet warning to the narrowest useful Docker action without changing tools."
        ></hope-doc-header>
        <section>
          <h2>From daemon objects to service shape</h2>
          <div class="body">
            <p>
              hope reads live Docker state and uses Compose project and service
              labels to reconstruct stacks. Replicas collapse under one service
              while every container remains inspectable, so the interface stays
              compact without hiding the object that actually failed.
            </p>
            <dl class="facts">
              <dt>stack</dt>
              <dd>
                Compose project identity, aggregate health, updates, networks,
                volumes, and lifecycle controls.
              </dd>
              <dt>service</dt>
              <dd>
                Replica group with shared image and configuration intent plus
                per-replica state.
              </dd>
              <dt>container</dt>
              <dd>
                Live health, restart state, image identity, ports, mounts,
                stats, logs, and focused actions.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Lifecycle without a shell-out</h2>
          <div class="body">
            <p>
              Operations go through the Docker API. Hope does not need the
              Compose CLI inside its container just to handle routine recovery.
            </p>
            <ul>
              <li>
                <strong>Start and stop</strong> a whole project while preserving
                its declared shape.
              </li>
              <li>
                <strong>Restart</strong> services or individual containers
                during recovery.
              </li>
              <li>
                <strong>Pull and redeploy</strong> when an image digest changes.
              </li>
              <li>
                <strong>Inspect before mutating</strong> with live logs, stats,
                health, image, network, and volume context in the same surface.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>A five-step incident loop</h2>
          <div class="body">
            <ol>
              <li>Open the stack and identify the degraded service.</li>
              <li>Inspect container state and health.</li>
              <li>Follow logs without leaving the control surface.</li>
              <li>Restart or redeploy at the narrowest useful scope.</li>
              <li>Confirm the resulting event and audit entry.</li>
            </ol>
            <p>
              The value is continuity: detection, diagnosis, action, and
              provenance stay attached to the same host, stack, and service
              context.
            </p>
          </div>
        </section>
        <hope-doc-note>
          Your workloads remain Docker workloads. Hope organizes and operates
          daemon state; it does not require a replacement scheduler.
        </hope-doc-note>
      </div>
    );
  }
}
