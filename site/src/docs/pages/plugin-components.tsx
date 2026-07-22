import { LoomElement } from "@toyz/loom";

export default class PluginComponentsPage extends LoomElement {
  update() {
    const example = `return plugin.Box(
  plugin.Heading("Replication", 3),
  plugin.CRow(
    plugin.KeyVal("primary", plugin.Badge("ready", plugin.ToneOK)),
    plugin.KeyVal("lag", plugin.Number(18, "ms")),
  ),
  plugin.Sparkline(12, 18, 14, 22, 18),
), nil`;
    return (
      <div class="doc">
        <hope-doc-header
          heading="components"
          lead="Compose custom plugin layouts from a constrained primitive vocabulary that remains styled, escaped, and rendered by Hope."
        ></hope-doc-header>
        <section>
          <h2>The escape hatch stays declarative</h2>
          <div class="body">
            <p>
              A component view returns data, not arbitrary browser code. Hope
              owns rendering, navigation, icon safety, responsive behavior, and
              the visual system while the plugin owns domain structure.
            </p>
            <hope-code-block lang="go" code={example}></hope-code-block>
          </div>
        </section>
        <section>
          <h2>Layout primitives</h2>
          <div class="body">
            <dl class="facts">
              <dt>Box</dt>
              <dd>
                A standard vertical panel body with an eight-pixel default gap.
              </dd>
              <dt>Stack</dt>
              <dd>
                A tighter vertical run for related values and compact facts.
              </dd>
              <dt>Row</dt>
              <dd>
                A wrapping horizontal composition with optional child weights.
              </dd>
              <dt>Grid</dt>
              <dd>A responsive auto-fill layout with optional column spans.</dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Content primitives</h2>
          <div class="body">
            <ul>
              <li>
                <strong>Heading, Text, KeyVal.</strong> Establish hierarchy and
                readable resource facts.
              </li>
              <li>
                <strong>Divider, Spacer.</strong> Add structure without
                introducing custom CSS.
              </li>
              <li>
                <strong>Icon, Cell.</strong> Reuse built-in or plugin-scoped
                icons and every rich cell type.
              </li>
              <li>
                <strong>Sparkline, Table.</strong> Embed compact trends or
                structured records inside a larger composition.
              </li>
              <li>
                <strong>Tones.</strong> Apply <code>ok</code>, <code>warn</code>
                , <code>bad</code>, or <code>info</code> only where semantics
                justify color.
              </li>
            </ul>
            <p>
              Unknown primitives are skipped instead of breaking the whole
              surface, preserving forward-compatible layouts.
            </p>
          </div>
        </section>
        <hope-doc-note>
          Prefer a built-in view when it fits. Component trees are most useful
          for compact domain dashboards and composed detail summaries.
        </hope-doc-note>
      </div>
    );
  }
}
