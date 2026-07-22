import { LoomElement } from "@toyz/loom";

export default class PluginsPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="plugin engine"
          lead="A container-native extension system with explicit approval, scoped reverse capabilities, and UI surfaces rendered by hope."
        ></hope-doc-header>
        <section>
          <h2>Discovery and trust</h2>
          <div class="body">
            <p>
              hope discovers labeled containers, derives stable identity from
              host plus Compose project and service, and fetches a plugin schema
              over JSON-RPC. Discovery is inert: an operator must enable the
              plugin before its methods or UI become active.
            </p>
            <ul>
              <li>
                Enable, disable, and forget are distinct trust operations.
              </li>
              <li>A schema fingerprint detects changed capabilities.</li>
              <li>Enabled calls use a plugin-specific bearer token.</li>
              <li>
                Concurrency, rate, and response limits contain misbehaving
                endpoints.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>UI contributions</h2>
          <div class="body">
            <dl class="facts">
              <dt>surfaces</dt>
              <dd>
                Container inspector, full page, dashboard widget, and stack
                widget.
              </dd>
              <dt>views</dt>
              <dd>
                Key/value, table, query, tree, chart, cards, stat, text, search,
                and component trees.
              </dd>
              <dt>actions</dt>
              <dd>
                Typed fields, confirmations, row actions, refresh hints, and
                structured results.
              </dd>
              <dt>streams</dt>
              <dd>Counter, log, and time-series frames.</dd>
              <dt>navigation</dt>
              <dd>
                Nested plugin pages, dynamic detail routes, breadcrumbs, and
                scoped icons.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Reverse capabilities</h2>
          <div class="body">
            <p>
              A plugin can request access back into hope. Grants are
              operator-controlled and persisted per scope.
            </p>
            <ul>
              <li>
                <code>events:subscribe</code> receives selected control-plane
                events.
              </li>
              <li>
                <code>events:publish</code> emits plugin alerts and domain
                events.
              </li>
              <li>
                <code>storage</code> provides namespaced persistent key/value
                state.
              </li>
              <li>
                <code>spec:label</code> changes plugin-owned labels through
                hope's mutation path.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Operations</h2>
          <div class="body">
            <p>
              The inspector exposes manifest, settings, granted scopes, advisory
              status, call metrics, errors, and latency. Actions enter hope's
              audit trail with plugin identity and target context.
            </p>
          </div>
        </section>
      </div>
    );
  }
}
