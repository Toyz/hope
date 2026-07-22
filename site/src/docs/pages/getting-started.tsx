import { LoomElement } from "@toyz/loom";

export default class GettingStartedPage extends LoomElement {
  update() {
    const prepare = `mkdir hope && cd hope
openssl rand -hex 32`;
    const config = `[server]
addr = ":8080"

[auth]
username = "operator"
password = "replace-this-password"
token_secret = "paste-the-random-value-here"
token_ttl = "24h"

[docker]
host = "unix:///var/run/docker.sock"

[store]
path = "/data/hope.db"

[updates]
enabled = true
interval = "6h"`;
    const compose = `services:
  hope:
    image: ghcr.io/toyz/hope:latest
    container_name: hope
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./config.toml:/app/config.toml:ro
      - hope-data:/data

volumes:
  hope-data:`;
    const launch = `docker compose up -d
docker compose logs -f hope`;
    const agentConfig = `[agent]
token = "replace-with-another-long-random-secret"
ws_path = "/agent/connect"`;
    const agentCompose = `services:
  hope-agent:
    image: ghcr.io/toyz/hope:latest
    container_name: hope-agent
    restart: unless-stopped
    command:
      - agent
      - --connect=wss://hope.example.com/agent/connect
      - --token=\${HOPE_AGENT_TOKEN}
      - --host-id=edge-1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock

    # Put HOPE_AGENT_TOKEN in a .env file beside this compose file.`;
    return (
      <div class="doc">
        <hope-doc-header
          heading="getting started"
          lead="Go from an empty directory to a persistent Hope control plane, then prove the complete observe-diagnose-operate-verify loop."
        ></hope-doc-header>
        <section>
          <h2>Before you start</h2>
          <div class="body">
            <dl class="facts">
              <dt>runtime</dt>
              <dd>
                A Docker-compatible daemon and Docker Compose on the machine
                that will run Hope.
              </dd>
              <dt>authority</dt>
              <dd>
                Permission to mount the daemon socket or connect to a secured
                remote Docker endpoint.
              </dd>
              <dt>network</dt>
              <dd>
                A trusted LAN or overlay for first setup. Add an authenticated
                TLS edge before public access.
              </dd>
              <dt>storage</dt>
              <dd>
                A persistent volume for <code>/data/hope.db</code> so state and
                encrypted credentials survive replacement.
              </dd>
            </dl>
            <hope-doc-note tone="warn">
              Mounting the Docker socket gives the Hope container
              root-equivalent control of the host. Only deploy it inside a
              trusted operator boundary.
            </hope-doc-note>
          </div>
        </section>
        <section>
          <h2>1. Create the deployment directory</h2>
          <div class="body">
            <p>
              Create a private directory and generate a random HMAC secret. The
              secret signs login sessions and protects credentials persisted in
              Hope's state database.
            </p>
            <hope-code-block lang="bash" code={prepare}></hope-code-block>
          </div>
        </section>
        <section>
          <h2>2. Write the required configuration</h2>
          <div class="body">
            <p>
              Save this as <code>config.toml</code>. Replace the password and
              token secret before starting the container. These are the only
              globally required authentication and Docker values; the store and
              update sections make the first deployment operationally complete.
            </p>
            <hope-code-block lang="toml" code={config}></hope-code-block>
            <ul>
              <li>
                <code>username</code>, <code>password</code>, and{" "}
                <code>token_secret</code> are mandatory.
              </li>
              <li>
                The socket URI must match the path mounted into the container.
              </li>
              <li>
                The store path must live under a persistent mount; otherwise
                state disappears with the container.
              </li>
              <li>
                A plaintext password works, but a bcrypt hash is preferable once
                the deployment is established.
              </li>
            </ul>
            <loom-link to="/configuration">
              Read every section requirement →
            </loom-link>
          </div>
        </section>
        <section>
          <h2>3. Run Hope with Compose</h2>
          <div class="body">
            <p>
              Save this as <code>compose.yml</code> beside the config file.
            </p>
            <hope-code-block lang="yaml" code={compose}></hope-code-block>
            <p>
              The config mount is required. The Docker socket is the local
              control path. The named volume persists Hope's bbolt state.
            </p>
            <hope-code-block lang="bash" code={launch}></hope-code-block>
            <p>
              Wait for the server to listen without configuration errors, then
              stop following logs with <code>Ctrl+C</code>. The container
              remains running in the background.
            </p>
          </div>
        </section>
        <section>
          <h2>4. Sign in and confirm discovery</h2>
          <div class="body">
            <ol>
              <li>
                Open <code>http://&lt;host&gt;:8080</code> from the trusted
                network and sign in.
              </li>
              <li>
                Confirm the dashboard reports the expected daemon version, OS,
                CPU, memory, container count, and image count.
              </li>
              <li>
                Open the topology rail and confirm Compose projects are grouped
                into stacks and services.
              </li>
              <li>
                Open Images and confirm repository tags, sizes, ages, and usage
                relationships are visible.
              </li>
            </ol>
            <p>
              Empty stack navigation usually means the daemon has no
              Compose-labeled containers or Hope is pointed at the wrong socket.
              Individual Docker containers remain inspectable through resource
              views even when they do not belong to a Compose project.
            </p>
          </div>
        </section>
        <section>
          <h2>5. Prove the control loop</h2>
          <div class="body">
            <p>
              Choose a non-critical service. This test proves more than the
              login page and should be completed before relying on Hope during
              an incident.
            </p>
            <ol>
              <li>Open the stack and select one service or replica.</li>
              <li>
                Follow its live logs and inspect health, image identity, ports,
                mounts, and resource state.
              </li>
              <li>
                Restart the narrowest safe target and watch current state
                recover.
              </li>
              <li>
                Open Audit and confirm the subject, host, action, target,
                result, and duration.
              </li>
              <li>
                Restart the Hope container and verify the state database and
                cached operational context remain available.
              </li>
            </ol>
          </div>
        </section>
        <section>
          <h2>6. Harden before wider access</h2>
          <div class="body">
            <ul>
              <li>
                Replace the bootstrap plaintext password with a bcrypt hash and
                keep <code>config.toml</code> readable only by the deployment
                owner.
              </li>
              <li>
                Terminate HTTPS at a trusted reverse proxy or use Cloudflare
                Access; Hope's listener does not provide TLS itself.
              </li>
              <li>
                Back up the private state volume together with the token secret
                needed to protect persisted credentials.
              </li>
              <li>
                Add explicit registry PATs when private images or Docker Hub
                rate limits matter.
              </li>
              <li>
                Do not enable API keys, socket proxy writes, plugins, agents, or
                Cloudflare integration until their authority is understood.
              </li>
            </ul>
          </div>
        </section>
        <section>
          <h2>7. Add the first remote host</h2>
          <div class="body">
            <p>
              Add the agent section to the main Hope config and recreate Hope.
              The token enables the WebSocket enrollment endpoint on the same
              HTTP listener.
            </p>
            <hope-code-block lang="toml" code={agentConfig}></hope-code-block>
            <p>
              On the remote Docker host, save the following as
              <code>compose.yml</code>. The agent uses the same Hope image and
              runs its <code>agent</code> command; there is no separate agent
              image.
            </p>
            <hope-code-block lang="yaml" code={agentCompose}></hope-code-block>
            <ol>
              <li>
                Create a private <code>.env</code> with{" "}
                <code>HOPE_AGENT_TOKEN=...</code>.
              </li>
              <li>
                Run <code>docker compose up -d</code> on the remote host.
              </li>
              <li>
                Confirm <code>edge-1</code> appears online with daemon and
                resource details.
              </li>
              <li>
                Open a remote stack and repeat the read, restart, and audit
                verification.
              </li>
            </ol>
            <loom-link to="/agents">Read the fleet agent model →</loom-link>
          </div>
        </section>
        <section>
          <h2>Where to go next</h2>
          <div class="body">
            <dl class="facts">
              <dt>fleet</dt>
              <dd>
                <loom-link to="/fleet">
                  Understand topology, attention signals, and host targeting.
                </loom-link>
              </dd>
              <dt>images</dt>
              <dd>
                <loom-link to="/images">
                  Set up freshness checks, registry credentials, and safe
                  cleanup.
                </loom-link>
              </dd>
              <dt>plugins</dt>
              <dd>
                <loom-link to="/plugins">
                  Add domain-specific UI behind explicit schema approval and
                  capability grants.
                </loom-link>
              </dd>
              <dt>automation</dt>
              <dd>
                <loom-link to="/interfaces">
                  Choose the browser, RPC, stream, or plugin integration
                  boundary.
                </loom-link>
              </dd>
            </dl>
          </div>
        </section>
      </div>
    );
  }
}
