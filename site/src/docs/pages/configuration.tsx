import { LoomElement } from "@toyz/loom";

export default class ConfigurationPage extends LoomElement {
  update() {
    const production = `[server]
addr = ":8080"

[auth]
username = "operator"
password = "$2a$12$..."
token_secret = "replace-with-a-long-random-secret"
token_ttl = "24h"

[docker]
host = "unix:///var/run/docker.sock"

[store]
path = "/data/hope.db"

[updates]
enabled = true
interval = "6h"`;
    const agents = `[agent]
token = "replace-with-a-long-random-secret"
ws_path = "/agent/connect"
# listen = ":9443"  # optional trusted-LAN TCP listener
# use = "remote-1"  # optional remote primary daemon`;
    const cloudflare = `[cloudflare]
enabled = true
api_token = "scoped-cloudflare-api-token"
account_id = "cloudflare-account-id"`;
    const plugins = `[plugins]
enabled = true
auto_reapprove = false

[plugins.limits]
# Zero or omitted values use Hope's built-in limits.

[plugins.catalog]
refresh = "12h"`;
    return (
      <div class="doc">
        <hope-doc-header
          heading="configuration"
          lead="Configure the trust boundary first, then add persistence, fleet connectivity, image intelligence, plugins, and ingress as your deployment grows."
        ></hope-doc-header>
        <section>
          <h2>Load and override</h2>
          <div class="body">
            <p>
              Start from <code>config.example.toml</code>, write the active
              values to <code>config.toml</code>, and mount that file into the
              container. Environment variables can override individual keys for
              secret injection.
            </p>
            <hope-code-block
              lang="bash"
              code={`cp config.example.toml config.toml\n# edit config.toml\ndocker compose up -d --build`}
            ></hope-code-block>
            <p>
              Keep stable, reviewable operations in TOML. Override secrets at
              runtime with <code>HOPE_*</code> environment variables, using the
              section and key joined with underscores, such as
              <code>HOPE_AUTH_TOKEN_SECRET</code>.
            </p>
          </div>
        </section>
        <section>
          <h2>A production baseline</h2>
          <div class="body">
            <hope-code-block lang="toml" code={production}></hope-code-block>
            <p>
              This shape gives Hope an authenticated HTTP surface, one primary
              daemon, durable state, and scheduled manifest checks. Terminate
              TLS at a trusted reverse proxy or authenticated edge.
            </p>
          </div>
        </section>
        <section>
          <h2>What is actually required</h2>
          <div class="body">
            <dl class="facts">
              <dt>always required</dt>
              <dd>
                <code>auth.username</code>, <code>auth.password</code>,{" "}
                <code>auth.token_secret</code>, and a non-empty{" "}
                <code>docker.host</code>.
              </dd>
              <dt>conditionally required</dt>
              <dd>
                <code>cloudflare.api_token</code> and{" "}
                <code>cloudflare.account_id</code> when{" "}
                <code>cloudflare.enabled=true</code>.
              </dd>
              <dt>required for durability</dt>
              <dd>
                <code>store.path</code> plus a persistent volume when state,
                credentials, plugin approvals, grants, settings, or storage must
                survive replacement.
              </dd>
              <dt>feature gates</dt>
              <dd>
                <code>agent.token</code>, <code>plugins.enabled</code>,{" "}
                <code>socketproxy.enabled</code>, and{" "}
                <code>cloudflare.enabled</code> activate optional subsystems.
              </dd>
              <dt>defaulted sections</dt>
              <dd>
                Server address, Docker host, token TTL, logging color, update
                schedule, catalog refresh, and socket-proxy allowlists have
                built-in defaults.
              </dd>
            </dl>
          </div>
        </section>
        <section>
          <h2>[server] and [auth]</h2>
          <div class="body">
            <h3>Server requirements</h3>
            <p>
              <code>server.addr</code> defaults to <code>:8080</code> and binds
              both the embedded UI and RPC API. It is not a public URL and does
              not configure TLS. Publish it through a trusted reverse proxy or
              authenticated edge when clients connect outside a private network.
            </p>
            <h3>Authentication requirements</h3>
            <ul>
              <li>
                <code>username</code> and <code>password</code> are mandatory.
                Password accepts plaintext or a bcrypt hash beginning with{" "}
                <code>$2</code>; bcrypt is the production choice.
              </li>
              <li>
                <code>token_secret</code> is mandatory and signs stateless
                bearer sessions. It also protects persisted registry
                credentials, so losing or changing it affects encrypted state.
              </li>
              <li>
                <code>token_ttl</code> defaults to <code>24h</code>; zero or a
                negative duration is reset to that default.
              </li>
              <li>
                <code>access_team</code> and <code>access_aud</code> are an
                optional pair for Cloudflare Access SSO. Password login remains
                available as a fallback.
              </li>
              <li>
                <code>api_keys</code> is optional. Each key grants headless,
                fleet-wide RPC authority and enables the API explorer; use long
                random values.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>[docker] and [compose]</h2>
          <div class="body">
            <h3>Docker endpoint</h3>
            <p>
              <code>docker.host</code> defaults to
              <code>unix:///var/run/docker.sock</code> and must resolve to a
              reachable Docker-compatible API. A container deployment must mount
              that socket at the configured path. A <code>tcp://</code> endpoint
              must already be secured by its network because Docker control is
              root-equivalent.
            </p>
            <h3>Registry config file</h3>
            <p>
              <code>docker.config</code> is optional and points to a mounted
              Docker <code>config.json</code>. Hope can read inline
              <code>auth</code> entries; it cannot execute desktop credential
              helpers or a configured <code>credsStore</code> from its minimal
              container. Prefer explicit <code>[[registry]]</code> entries when
              that file does not contain credentials directly.
            </p>
            <h3>Compose boundary</h3>
            <p>
              <code>compose.roots</code> is optional. An empty list trusts
              Compose labels from every visible container. Populate it with
              approved on-disk project roots when Hope should operate only a
              bounded set of Compose projects.
            </p>
          </div>
        </section>
        <section>
          <h2>[[registry]], [store], and [updates]</h2>
          <div class="body">
            <h3>Explicit registries</h3>
            <p>
              Repeat <code>[[registry]]</code> for each private registry. Supply
              the exact <code>server</code> used by image references plus
              <code>username</code> and <code>password</code> or PAT. These
              credentials are used for manifest checks and pulls; prefer
              pull-scoped tokens.
            </p>
            <h3>Persistent store</h3>
            <p>
              An empty <code>store.path</code> disables bbolt persistence. Basic
              stack discovery and Docker operations still work, but the agent
              roster, freshness cache, deploy specs, and UI-added registry
              credentials become ephemeral. Plugin approvals, grants, settings,
              tokens, and namespaced plugin storage require the store and fail
              rather than pretending to be durable without it.
            </p>
            <p>
              Mount the parent directory on persistent private storage. Hope
              writes the database with mode <code>0600</code> and encrypts
              registry credentials using <code>auth.token_secret</code>.
            </p>
            <h3>Update crawler</h3>
            <p>
              <code>updates.enabled</code> defaults to <code>true</code> and
              <code>updates.interval</code> to <code>6h</code>. Checks resolve
              manifests but never pull layers. Disable the section to eliminate
              registry traffic, or increase the interval when anonymous rate
              limits are tight. Non-positive intervals reset to six hours.
            </p>
          </div>
        </section>
        <section>
          <h2>[agent] requirements</h2>
          <div class="body">
            <hope-code-block lang="toml" code={agents}></hope-code-block>
            <ul>
              <li>
                <code>token</code> is the feature gate and shared enrollment
                secret. Empty means the agent hub is disabled.
              </li>
              <li>
                <code>ws_path</code> defaults to <code>/agent/connect</code> and
                runs on Hope's main HTTP listener, allowing agents to use
                WebSocket over port 443 through an edge.
              </li>
              <li>
                <code>listen</code> optionally adds a raw TCP listener for a
                trusted LAN or overlay. It is not required for WebSocket agents.
              </li>
              <li>
                <code>use</code> optionally makes one connected agent ID the
                primary Docker source. Hope waits for that host during startup,
                so the ID must match the agent exactly.
              </li>
              <li>
                Every agent needs outbound reachability to Hope, the same token,
                a stable host ID, and access to its local Docker-compatible
                endpoint.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>[socketproxy] requirements</h2>
          <div class="body">
            <p>
              Set <code>enabled=true</code> only when another trusted client
              needs constrained Docker API access. The listener defaults to
              <code>:2375</code>; methods default to <code>GET</code> and
              <code>HEAD</code>, with ping, version, info, container, and image
              paths allowed.
            </p>
            <ul>
              <li>
                The proxy forwards to the configured Docker endpoint, so that
                endpoint must already be reachable by Hope.
              </li>
              <li>
                Bind the listener only to a trusted LAN or overlay; the proxy
                does not turn Docker authority into low-risk public HTTP.
              </li>
              <li>
                Review method and path patterns together. Adding mutation
                methods or broad paths can expose root-equivalent operations.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>[cloudflare] requirements</h2>
          <div class="body">
            <hope-code-block lang="toml" code={cloudflare}></hope-code-block>
            <ul>
              <li>
                <code>api_token</code> and <code>account_id</code> are both
                required when enabled; startup validation rejects an incomplete
                pair.
              </li>
              <li>
                The API token needs Account / Cloudflare Tunnel: Edit and
                zone-wide DNS: Edit plus Zone: Read.
              </li>
              <li>
                Live connector health can additionally use Cloudflare One
                Connector / cloudflared: Read.
              </li>
              <li>
                Hope does not run <code>cloudflared</code>. A connector
                container must already use a remotely managed tunnel token and
                carry <code>ink.hope.tunnel=&lt;tunnel-id&gt;</code>.
              </li>
              <li>
                Use <code>ink.hope.connector.default=1</code> for the shared
                default and <code>ink.hope.connector</code> for a friendly
                display name.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>[plugins] requirements</h2>
          <div class="body">
            <hope-code-block lang="toml" code={plugins}></hope-code-block>
            <ul>
              <li>
                <code>enabled=true</code> starts fleet discovery for containers
                labeled <code>hope.plugin=true</code> with a reachable{" "}
                <code>hope.plugin.port</code>.
              </li>
              <li>
                A persistent <code>store.path</code> is required for durable
                approval, bearer tokens, scope grants, operator settings,
                catalog cache, and plugin storage.
              </li>
              <li>
                Zero or omitted <code>[plugins.limits]</code> fields use Hope's
                built-in per-plugin caps for concurrent calls and streams, call
                rate and burst, frame size, and frame rate.
              </li>
              <li>
                <code>auto_reapprove=true</code> accepts changed schemas and
                images automatically. Use it only while iterating on trusted
                development plugins.
              </li>
              <li>
                Built-in first-party catalog entries require no repo
                configuration. Remote <code>[[plugins.catalog.repo]]</code>{" "}
                entries need a manifest URL; later repos override earlier IDs.
              </li>
              <li>
                <code>trust_images=true</code> permits that catalog to offer
                images outside <code>ghcr.io/toyz/</code>. It vouches for the
                repo's images, environment, and labels, so grant it only to a
                source whose containers you would run manually.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>[log] requirements</h2>
          <div class="body">
            <p>
              Logging has no required keys. <code>color=true</code> is the
              default for terminal output. Set <code>json=true</code> for
              structured lines consumed by an aggregator; disable color in
              non-terminal pipelines that should not receive ANSI sequences.
            </p>
          </div>
        </section>
        <section>
          <h2>Security consequences</h2>
          <div class="body">
            <ul>
              <li>
                <code>token_secret</code> signs sessions and protects persisted
                credentials; make it random, durable, and backed up securely.
              </li>
              <li>
                API keys and agent enrollment tokens are administrative
                credentials with fleet-wide impact.
              </li>
              <li>
                Without <code>[store].path</code>, agent roster and caches are
                ephemeral and durable plugin trust workflows cannot operate.
              </li>
              <li>
                <code>auto_reapprove</code> is for a plugin development loop,
                not an unattended production trust policy.
              </li>
              <li>
                The socket proxy is read-only by default; expanding methods or
                paths expands who can control Docker.
              </li>
            </ul>
          </div>
        </section>
        <hope-doc-note tone="warn">
          Never commit token secrets, API keys, registry passwords, or provider
          credentials.
        </hope-doc-note>
      </div>
    );
  }
}
