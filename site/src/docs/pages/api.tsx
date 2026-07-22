import { LoomElement } from "@toyz/loom";

export default class ApiPage extends LoomElement {
  update() {
    const curl = `curl -X POST https://hope.example/rpc/Stacks/list \\
  -H "Authorization: Bearer $HOPE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Hope-Host: local" \\
  -d '{"args": []}'`;
    return (
      <div class="doc">
        <hope-doc-header
          heading="api"
          lead="Automate the same host-aware control-plane operations used by Hope's interface, with a discoverable contract instead of a separate reduced API."
        ></hope-doc-header>
        <section>
          <h2>Calling convention</h2>
          <div class="body">
            <p>
              Send <code>POST /rpc/&lt;Service&gt;/&lt;method&gt;</code>,
              authenticate with a configured API key, and place named or
              positional method arguments in <code>args</code>.
            </p>
            <hope-code-block lang="bash" code={curl}></hope-code-block>
          </div>
        </section>
        <section>
          <h2>What to automate</h2>
          <div class="body">
            <ul>
              <li>
                Read fleet, stack, container, image, network, volume, agent, and
                system state for internal tooling.
              </li>
              <li>
                Trigger explicit lifecycle operations from deployment pipelines
                while retaining Hope's audit boundary.
              </li>
              <li>
                Target a local or remote host with the same service method by
                changing request context, not endpoint families.
              </li>
              <li>
                Generate clients or operator tools from introspection instead of
                copying undocumented browser calls.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Host targeting</h2>
          <div class="body">
            <p>
              Set <code>X-Hope-Host</code> to <code>local</code> or an enrolled
              agent ID. Explicit targeting keeps automation independent of a
              user's active browser scope.
            </p>
          </div>
        </section>
        <section>
          <h2>Discover the contract</h2>
          <div class="body">
            <dl class="facts">
              <dt>/rpc/_explorer/</dt>
              <dd>Browse and invoke registered services and methods.</dd>
              <dt>/rpc/_introspect</dt>
              <dd>
                Read the machine-consumable schema for clients and tooling.
              </dd>
            </dl>
            <p>
              The explorer is available when API keys are configured. Use it to
              inspect current method arguments and responses for the exact Hope
              version you operate.
            </p>
          </div>
        </section>
        <hope-doc-note tone="warn">
          An API key can operate every host available to hope. Store it as an
          administrative secret and rotate it through configuration.
        </hope-doc-note>
      </div>
    );
  }
}
