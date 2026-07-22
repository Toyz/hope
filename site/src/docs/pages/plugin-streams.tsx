import { LoomElement } from "@toyz/loom";

export default class PluginStreamsPage extends LoomElement {
  update() {
    const loop = `p.Stream("connections", "Connections", plugin.Counter,
  func(ctx context.Context, emit plugin.EmitFunc) error {
    for {
      select {
      case <-ctx.Done():
        return ctx.Err()
      case <-ticker.C:
        if err := emit(map[string]any{"open": current()}); err != nil {
          return err
        }
      }
    }
  })`;
    return (
      <div class="doc">
        <hope-doc-header
          heading="streams & events"
          lead="Push live operational data into Hope and react to fleet activity without turning a plugin into an unbounded background process."
        ></hope-doc-header>
        <section>
          <h2>Three stream contracts</h2>
          <div class="body">
            <dl class="facts">
              <dt>counter</dt>
              <dd>Keyed numeric frames rendered as live stat values.</dd>
              <dt>log</dt>
              <dd>
                Append-only line frames rendered in a scrollable log surface.
              </dd>
              <dt>series</dt>
              <dd>
                Numeric value arrays with optional labels rendered as a live
                trend.
              </dd>
            </dl>
            <p>
              Frames travel as flushed NDJSON results and update the mounted
              surface as they arrive.
            </p>
          </div>
        </section>
        <section>
          <h2>Cancellation is the lifecycle</h2>
          <div class="body">
            <hope-code-block lang="go" code={loop}></hope-code-block>
            <p>
              When navigation or browser disconnect closes the request, Hope
              cancels the stream context. Every long-running handler must select
              on <code>ctx.Done()</code> so UI lifecycle does not leak
              goroutines.
            </p>
          </div>
        </section>
        <section>
          <h2>Fleet events and plugin events</h2>
          <div class="body">
            <ul>
              <li>
                Declare <code>events:subscribe</code> to receive selected Hope
                events through the initialized callback channel.
              </li>
              <li>
                Keep event handlers idempotent because delivery may be repeated.
              </li>
              <li>
                Declare <code>events:publish</code> to emit domain events or
                manage plugin alerts.
              </li>
              <li>
                Use stream limits for concurrent connections, frame size, and
                frame rate to contain noisy integrations.
              </li>
            </ul>
          </div>
        </section>
      </div>
    );
  }
}
