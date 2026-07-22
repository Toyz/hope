import { LoomElement } from "@toyz/loom";

export default class PluginTrustPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="discovery & trust"
          lead="Let containers advertise capabilities without letting discovery silently become execution authority."
        ></hope-doc-header>
        <section>
          <h2>Discovery is inert</h2>
          <div class="body">
            <p>
              Hope scans labeled containers and reads <code>hope.schema</code>{" "}
              to show identity, UI contributions, requested scopes, and protocol
              shape. Until an operator enables the plugin, its authenticated
              methods and contributions remain inactive.
            </p>
            <dl class="facts">
              <dt>hope.plugin</dt>
              <dd>
                Set to <code>true</code> to opt the container into discovery.
              </dd>
              <dt>hope.plugin.port</dt>
              <dd>
                The container port where Hope can reach the JSON-RPC endpoint.
              </dd>
              <dt>hope.plugin.path</dt>
              <dd>
                Optional endpoint override; the default is <code>/__hope</code>.
              </dd>
              <dt>title and icon</dt>
              <dd>
                Optional pre-schema hints used while discovery information is
                loading.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Approval binds the contract</h2>
          <div class="body">
            <ol>
              <li>
                Hope derives plugin identity from its host and Compose
                placement.
              </li>
              <li>
                The operator reviews schema identity, surfaces, and requested
                reverse scopes.
              </li>
              <li>
                Enablement stores a schema fingerprint and plugin-specific
                bearer context.
              </li>
              <li>
                A changed image or schema invalidates that approval and returns
                the plugin to review.
              </li>
            </ol>
            <p>
              <code>auto_reapprove</code> removes this interruption for a local
              development loop. In production it also removes the human review
              that makes schema mutation visible.
            </p>
          </div>
        </section>
        <section>
          <h2>Reverse capabilities are separate grants</h2>
          <div class="body">
            <dl class="facts">
              <dt>events:subscribe</dt>
              <dd>
                Receive selected fleet events through the plugin callback.
              </dd>
              <dt>events:publish</dt>
              <dd>Publish domain events and open or resolve plugin alerts.</dd>
              <dt>storage</dt>
              <dd>Use durable per-install namespaced key/value state.</dd>
              <dt>spec:label</dt>
              <dd>
                Mutate plugin-owned service labels through Hope's controlled
                path.
              </dd>
            </dl>
          </div>
        </section>
        <hope-doc-note tone="warn">
          Durable approvals, tokens, grants, settings, and plugin storage
          require a configured Hope state store.
        </hope-doc-note>
      </div>
    );
  }
}
