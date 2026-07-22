import { LoomElement } from "@toyz/loom";

export default class UpdatesPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="updates & freshness"
          lead="Replace guesswork around mutable image tags with fleet-wide digest evidence, then keep rollout timing and blast radius in operator hands."
        ></hope-doc-header>
        <section>
          <h2>Manifest checks, not surprise pulls</h2>
          <div class="body">
            <p>
              hope compares the digest behind a running image reference with the
              current registry manifest. The crawler asks what is available; it
              does not pull layers or restart a workload just to answer that
              question.
            </p>
            <dl class="facts">
              <dt>collect</dt>
              <dd>
                Resolve registry manifests on a schedule or through a manual
                check.
              </dd>
              <dt>compare</dt>
              <dd>
                Match the available digest against the image identity behind
                each running container.
              </dd>
              <dt>roll up</dt>
              <dd>
                Surface stale state at container, service, stack, host, and
                fleet levels.
              </dd>
              <dt>act</dt>
              <dd>
                Move from the stale signal into an explicit pull and redeploy
                workflow.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Designed for intentional rollout</h2>
          <div class="body">
            <p>
              An available digest is information, not an automatic rollout. hope
              leaves scheduling, blast radius, and service readiness with the
              operator. Mutable tags such as <code>latest</code> are supported,
              but immutable version tags make change intent easier to review.
            </p>
            <ul>
              <li>
                Use configured registry credentials for private manifests and
                pulls.
              </li>
              <li>
                Persist the freshness cache so fleet state survives a
                control-plane restart.
              </li>
              <li>
                Increase the interval when anonymous registry rate limits are a
                concern.
              </li>
              <li>
                Redeploy a narrow service first when readiness or compatibility
                needs observation.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Operator workflow</h2>
          <div class="body">
            <ol>
              <li>
                Read the fleet update count and identify the affected host and
                stack.
              </li>
              <li>
                Inspect the service replicas and confirm the running versus
                available digest.
              </li>
              <li>
                Review release risk outside Hope, then choose the rollout scope.
              </li>
              <li>
                Pull and redeploy, watch live state settle, and verify the stale
                marker clears.
              </li>
              <li>
                Use audit history to confirm who initiated the rollout and
                whether it succeeded.
              </li>
            </ol>
          </div>
        </section>
      </div>
    );
  }
}
