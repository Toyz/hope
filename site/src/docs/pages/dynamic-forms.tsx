import { LoomElement } from "@toyz/loom";

export default class DynamicFormsPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="actions & forms"
          lead="Turn plugin mutations into structured, confirmable operator workflows with typed input, live choices, audited identity, and explicit results."
        ></hope-doc-header>
        <section>
          <h2>Action lifecycle</h2>
          <div class="body">
            <ol>
              <li>
                Hope resolves dynamic options and collects the action's declared
                fields.
              </li>
              <li>
                Dangerous actions receive an explicit confirmation in every
                surface.
              </li>
              <li>
                The plugin validates the merged page, row, and form context
                before mutating.
              </li>
              <li>
                A structured result drives the toast, modal state, and optional
                view refresh.
              </li>
              <li>
                Hope records method, plugin identity, target context, danger
                level, outcome, and duration.
              </li>
            </ol>
          </div>
        </section>
        <section>
          <h2>Field contracts</h2>
          <div class="body">
            <dl class="facts">
              <dt>text / textarea</dt>
              <dd>
                Single- or multi-line string input with defaults, placeholders,
                hints, and optional state.
              </dd>
              <dt>select</dt>
              <dd>
                A stable string value chosen from static options or an
                RPC-populated options method.
              </dd>
              <dt>toggle</dt>
              <dd>
                A binary operator choice delivered as the action's declared
                value.
              </dd>
              <dt>kv</dt>
              <dd>
                A structured key/value editor for labels, annotations, or
                compact maps.
              </dd>
              <dt>group</dt>
              <dd>
                A repeatable array of nested field objects for multi-item
                configuration.
              </dd>
              <dt>options provider</dt>
              <dd>
                A plugin method supplies current select choices from values
                already entered, enabling cascading selections.
              </dd>
              <dt>resolver</dt>
              <dd>
                A method returns a component tree rendered as a live preview or
                confirmation surface while the form changes.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Result contract</h2>
          <div class="body">
            <p>
              Return a message and optional <code>ok</code>, <code>level</code>,
              and <code>refetch</code> fields. Errors keep the form open and do
              not refresh; successful actions refresh by default so persisted
              changes appear immediately.
            </p>
          </div>
        </section>
        <section>
          <h2>Design rules</h2>
          <div class="body">
            <ul>
              <li>
                Keep initial fields useful before any resolver call completes.
              </li>
              <li>
                Return stable option values even when display labels change.
              </li>
              <li>
                Validate again inside the action method; UI resolution is not an
                authorization boundary.
              </li>
              <li>
                Use danger confirmation for destructive outcomes, not as a
                substitute for clear field labels.
              </li>
            </ul>
          </div>
        </section>
      </div>
    );
  }
}
