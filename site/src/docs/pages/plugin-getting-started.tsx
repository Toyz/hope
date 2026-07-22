import { LoomElement } from "@toyz/loom";

export default class PluginGettingStartedPage extends LoomElement {
  update() {
    const endpoint = `p := plugin.New("hello-plugin", "1.0.0")\np.View("hello", "Hello", plugin.KV, func(ctx context.Context) (any, error) {\n  return map[string]any{"status": "ready"}, nil\n})\nlog.Fatal(p.ListenAndServe(":8080"))`;
    const labels = `labels:\n  - "hope.plugin=true"\n  - "hope.plugin.port=8080"\n  - "hope.plugin.path=/__hope"`;
    return (
      <div class="doc">
        <hope-doc-header
          heading="plugin getting started"
          lead="Expose a schema endpoint, label its container, enable the platform, then approve the discovered plugin."
        ></hope-doc-header>
        <section>
          <h2>1. Build the endpoint</h2>
          <div class="body">
            <p>
              Use the Go plugin package to declare views, actions, streams,
              settings, and layouts from one schema.
            </p>
            <hope-code-block lang="go" code={endpoint}></hope-code-block>
          </div>
        </section>
        <section>
          <h2>2. Advertise the container</h2>
          <div class="body">
            <hope-code-block lang="yaml" code={labels}></hope-code-block>
            <p>
              The port is the container port reachable by hope. Set a path only
              when the endpoint is not at the protocol default.
            </p>
          </div>
        </section>
        <section>
          <h2>3. Enable the platform</h2>
          <div class="body">
            <hope-code-block
              lang="toml"
              code={`[plugins]\nenabled = true`}
            ></hope-code-block>
            <p>
              Open Plugins, inspect the discovered identity and requested
              scopes, then enable it. The first schema fingerprint becomes the
              approved contract.
            </p>
          </div>
        </section>
        <section>
          <h2>4. Add capabilities deliberately</h2>
          <div class="body">
            <ul>
              <li>
                Add a container or page layout before introducing custom
                component trees.
              </li>
              <li>Use settings for operator-owned configuration.</li>
              <li>Request reverse scopes only when the feature needs them.</li>
              <li>
                Return structured status and action results so failures remain
                visible.
              </li>
              <li>
                Redeploy and verify schema-change approval behavior before
                shipping.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>5. Test the trust lifecycle</h2>
          <div class="body">
            <ol>
              <li>
                Start the plugin and confirm Hope discovers it without
                activating its UI.
              </li>
              <li>
                Review the schema and requested scopes, then enable the
                instance.
              </li>
              <li>
                Open its contributed surface and exercise reads, actions, and
                stream cancellation.
              </li>
              <li>
                Change the declared schema, redeploy, and confirm Hope requires
                reapproval.
              </li>
              <li>
                Inspect plugin metrics, advisory status, and audit entries
                before publishing the image.
              </li>
            </ol>
          </div>
        </section>
        <section>
          <h2>Reference implementations</h2>
          <div class="body">
            <dl class="facts">
              <dt>hello-world</dt>
              <dd>
                A compact starting point covering common views, one action, a
                stream, and settings.
              </dd>
              <dt>kitchen-sink</dt>
              <dd>
                The protocol exercise: surfaces, dynamic pages, rich cells,
                forms, streams, storage, and events.
              </dd>
              <dt>hope-postgres</dt>
              <dd>
                A product-shaped integration showing how domain operations
                belong inside a matched container surface.
              </dd>
            </dl>
          </div>
        </section>
        <hope-doc-note tone="warn">
          Without a persistent store, approvals, grants, settings, and plugin
          tokens cannot survive restart.
        </hope-doc-note>
      </div>
    );
  }
}
