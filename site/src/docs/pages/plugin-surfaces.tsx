import { LoomElement } from "@toyz/loom";

export default class PluginSurfacesPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="surfaces & pages"
          lead="Place plugin functionality where its operating context already exists, from one container inspector to a full product area."
        ></hope-doc-header>
        <section>
          <h2>Mount points</h2>
          <div class="body">
            <dl class="facts">
              <dt>container</dt>
              <dd>
                A matched inspector panel for image-, label-, or
                service-specific functionality.
              </dd>
              <dt>stack</dt>
              <dd>
                A widget attached to a Compose project when one of its
                containers matches.
              </dd>
              <dt>dashboard</dt>
              <dd>
                A fleet or host summary widget for signals that deserve
                persistent visibility.
              </dd>
              <dt>page</dt>
              <dd>
                A full plugin-owned workspace reachable from Hope navigation.
              </dd>
            </dl>
            <p>
              Matching keeps an integration contextual. A database plugin can
              appear only beside database containers instead of adding global UI
              to every operator workflow.
            </p>
          </div>
        </section>
        <section>
          <h2>Page architecture</h2>
          <div class="body">
            <ul>
              <li>
                Give each contribution a stable ID so navigation and approval
                fingerprints remain predictable.
              </li>
              <li>
                Attach header actions to the page when they affect the whole
                resource, not one table row.
              </li>
              <li>
                Use hidden pages for detail routes that should be reachable but
                absent from the rail.
              </li>
              <li>
                Declare <code>ParamKey</code>, subtitle templates, and
                breadcrumbs for master-detail flows.
              </li>
              <li>
                Return dynamic page items when the plugin's own domain
                determines the navigation tree.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Choose the smallest surface</h2>
          <div class="body">
            <p>
              Start with a built-in view inside the closest existing context.
              Use a full page when the integration has its own navigation or
              multi-step operating flow, and use a component tree only when the
              standard views cannot express the information clearly.
            </p>
          </div>
        </section>
      </div>
    );
  }
}
