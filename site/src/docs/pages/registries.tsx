import { LoomElement } from "@toyz/loom";

export default class RegistriesPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="registries"
          lead="Authenticate private image checks and rollouts once at the control plane instead of rebuilding registry setup independently on every Docker host."
        ></hope-doc-header>
        <section>
          <h2>Credential scope</h2>
          <div class="body">
            <p>
              A registry entry identifies the registry host and the credentials
              used for authenticated image operations. hope distributes the
              usable credential context to local and connected agent operations
              instead of embedding passwords in stack files.
            </p>
            <dl class="facts">
              <dt>update checks</dt>
              <dd>
                Authenticate registry manifest lookups so private images
                participate in fleet freshness.
              </dd>
              <dt>pull and redeploy</dt>
              <dd>
                Use the same credential context when a local or remote host
                pulls a replacement image.
              </dd>
              <dt>durability</dt>
              <dd>
                UI-added credentials persist in the state store and are
                protected with the authentication token secret.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Operating guidance</h2>
          <div class="body">
            <ul>
              <li>
                Enter the registry host exactly as it appears in image
                references.
              </li>
              <li>Prefer scoped access tokens over account passwords.</li>
              <li>
                Grant pull-only access unless a workflow explicitly needs more.
              </li>
              <li>Rotate credentials in hope when registry access changes.</li>
              <li>Remove credentials that no active image source uses.</li>
              <li>
                When an authenticated pull fails, fix the credential or registry
                path; Hope does not silently present a stale image as a
                successful update.
              </li>
            </ul>
          </div>
        </section>
        <hope-doc-note tone="warn">
          Registry credentials are fleet secrets. Protect both the hope data
          directory and its configuration.
        </hope-doc-note>
      </div>
    );
  }
}
