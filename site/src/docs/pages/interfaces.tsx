import { LoomElement } from "@toyz/loom";

export default class InterfacesPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="interfaces"
          lead="Use one control plane through an operator UI, a discoverable typed RPC contract, streaming operations, and explicitly trusted plugin endpoints."
        ></hope-doc-header>
        <section>
          <h2>One operation model, several clients</h2>
          <div class="body">
            <dl class="facts">
              <dt>browser</dt>
              <dd>
                The full fleet explorer for repeated diagnosis, comparison,
                lifecycle work, and guarded destructive actions.
              </dd>
              <dt>RPC</dt>
              <dd>
                Authenticated service methods used by the browser and available
                to internal automation through API keys.
              </dd>
              <dt>operation streams</dt>
              <dd>
                NDJSON progress for pulls, deploys, pruning, and other work
                whose intermediate state matters.
              </dd>
              <dt>plugin JSON-RPC</dt>
              <dd>
                A proxied container endpoint with schema approval, bearer
                identity, resource limits, and capability grants.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Why the shared contract matters</h2>
          <div class="body">
            <ul>
              <li>
                Automation does not receive a weaker shadow API with different
                behavior from the UI.
              </li>
              <li>
                Host targeting remains explicit for local and remote operations.
              </li>
              <li>
                Introspection exposes registered services, methods, and argument
                shapes for the running version.
              </li>
              <li>
                Control-plane mutations keep the same audit context regardless
                of whether a person or automation initiated them.
              </li>
              <li>
                Plugins extend presentation and domain actions without receiving
                arbitrary browser execution.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Choose the boundary deliberately</h2>
          <div class="body">
            <p>
              Use the browser for interactive fleet work, RPC for trusted
              automation, operation streams when progress must be observed, and
              plugins when a domain integration should live inside Hope's UI and
              trust model. API keys and plugin grants remain administrative
              capabilities, not convenience credentials.
            </p>
          </div>
        </section>
      </div>
    );
  }
}
