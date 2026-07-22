import { LoomElement } from "@toyz/loom";

export default class AuditPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="audit"
          lead="Answer who changed the fleet, what they targeted, and whether it worked without relying on shell history or a plugin's own account of events."
        ></hope-doc-header>
        <section>
          <h2>Provenance at the control plane</h2>
          <div class="body">
            <p>
              Hope records mutations where they cross the control plane. That
              ties operator, plugin, and system activity to the host and Docker
              resource that actually received the operation.
            </p>
            <dl class="facts">
              <dt>who</dt>
              <dd>Authenticated subject or plugin identity.</dd>
              <dt>what</dt>
              <dd>Category, action, and target operation.</dd>
              <dt>where</dt>
              <dd>Host, stack, service, container, or plugin scope.</dd>
              <dt>result</dt>
              <dd>Success or failure, timing, and available error context.</dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Useful during incidents and review</h2>
          <div class="body">
            <ul>
              <li>
                Trace a restart or redeploy back to its authenticated subject
                and exact target.
              </li>
              <li>
                Separate failed attempts from successful mutations instead of
                inferring from current state.
              </li>
              <li>
                Filter by container, stack, image, volume, network, tunnel,
                plugin, agent, or registry activity.
              </li>
              <li>
                Use duration and error context to distinguish a denied action
                from a slow or failed downstream operation.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Plugin trust boundary</h2>
          <div class="body">
            <p>
              Plugin mutations are audited by hope at the capability boundary.
              The record carries plugin identity and granted context; it does
              not depend on extension code reporting its own activity correctly.
            </p>
            <p>
              This makes extensions useful without turning them into an opaque
              second control plane. Operator actions and plugin actions remain
              reviewable in the same fleet history.
            </p>
          </div>
        </section>
        <hope-doc-note>
          Persist the state store if audit history must survive container
          replacement.
        </hope-doc-note>
      </div>
    );
  }
}
