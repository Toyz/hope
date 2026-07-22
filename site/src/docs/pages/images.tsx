import { LoomElement } from "@toyz/loom";

export default class ImagesPage extends LoomElement {
  update() {
    return (
      <div class="doc">
        <hope-doc-header
          heading="images"
          lead="See where disk is going, which workloads pin each image, and what can be reclaimed before running a destructive Docker cleanup."
        ></hope-doc-header>
        <section>
          <h2>Fleet image inventory</h2>
          <div class="body">
            <p>
              The Images workspace combines repository tags, image IDs, size,
              age, usage, host, and stack context. In fleet mode Hope flattens
              every host into one size-sorted inventory so the largest reclaim
              opportunities are visible first.
            </p>
            <dl class="facts">
              <dt>used</dt>
              <dd>
                Referenced by one or more containers, with the consuming stack
                and service shown.
              </dd>
              <dt>unused</dt>
              <dd>
                Tagged but not referenced by a current container; removable but
                likely to require a future pull.
              </dd>
              <dt>dangling</dt>
              <dd>
                Untagged image state left behind by builds or replacement pulls.
              </dd>
              <dt>reclaimable</dt>
              <dd>
                Disk composition and potential recovery shown per host and
                across the fleet.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>Cleanup with context</h2>
          <div class="body">
            <ul>
              <li>
                Search and segment the inventory before selecting individual
                images.
              </li>
              <li>
                Inspect tags, identity, size, creation time, and current
                consumers before removal.
              </li>
              <li>
                Prune dangling images for conservative cleanup or all unused
                images for deeper recovery.
              </li>
              <li>
                Run prune against one daemon or sequence it across every
                connected host.
              </li>
              <li>
                Use redeploy and prune when a running container still pins an
                otherwise dangling image.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>Image operations stay connected</h2>
          <div class="body">
            <p>
              Registry credentials, freshness checks, pulls, redeploys, and disk
              cleanup share the same host and image identity. That lets an
              operator move from “this image is stale” to “this replacement is
              running and the old bytes are reclaimable” without stitching
              together separate tools.
            </p>
          </div>
        </section>
        <hope-doc-note tone="warn">
          Removing an in-use image is forceful and can leave a running container
          backed by bytes that must be pulled again. Prefer redeploy-and-prune
          when replacing active image state.
        </hope-doc-note>
      </div>
    );
  }
}
