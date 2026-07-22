import { LoomElement } from "@toyz/loom";

export default class PluginViewsPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="views & cells"
          lead="Return structured domain data and let Hope render it with the same dense, accessible operating language as the rest of the product."
        ></hope-doc-header>
        <section>
          <h2>Built-in views</h2>
          <div class="body">
            <dl class="facts">
              <dt>kv / stat</dt>
              <dd>Resource facts and compact operational counters.</dd>
              <dt>table / query</dt>
              <dd>
                Sortable records, server-side data sets, and query-driven
                results.
              </dd>
              <dt>tree / cards</dt>
              <dd>
                Hierarchies and browsable entities with links, fields, images,
                and tones.
              </dd>
              <dt>chart</dt>
              <dd>Bar or line series with labels, axes, and legends.</dd>
              <dt>text</dt>
              <dd>
                Logs, configuration, diagnostics, and other monospace output.
              </dd>
              <dt>search</dt>
              <dd>
                Plugin-domain lookup that routes directly to a matching detail
                page.
              </dd>
              <dt>component</dt>
              <dd>
                A safe primitive tree for layouts the standard contracts cannot
                express.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Tables that scale</h2>
          <div class="body">
            <ul>
              <li>
                Use row detail or a right-side flyout to keep a data set visible
                while inspecting one record.
              </li>
              <li>
                Add row actions only when the action belongs to that record and
                can carry its row context.
              </li>
              <li>
                Enable server-side paging, sorting, text filters, and facets for
                data that should not ship in one response.
              </li>
              <li>
                Use refresh, static caching, or interval refresh based on how
                quickly the source changes.
              </li>
              <li>
                Define a useful empty state so “no rows” is distinguishable from
                a failed request.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Rich cells preserve meaning</h2>
          <div class="body">
            <dl class="facts">
              <dt>badge / progress</dt>
              <dd>Semantic status and bounded completion signals.</dd>
              <dt>link / detail link</dt>
              <dd>
                External destinations or plugin-relative master-detail
                navigation.
              </dd>
              <dt>time / number</dt>
              <dd>Relative timestamps and aligned, unit-aware quantities.</dd>
              <dt>code / image</dt>
              <dd>
                Identifiers, snippets, thumbnails, lightboxes, and immutable
                image caching.
              </dd>
            </dl>
            <p>
              Unknown cell types fall back to text, keeping newer plugins
              readable on older compatible Hope instances.
            </p>
          </div>
        </section>
      </div>
    );
  }
}
