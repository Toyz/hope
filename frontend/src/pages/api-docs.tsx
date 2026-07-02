// API docs: how to call hope's RPC surface headlessly — calling convention,
// headers, per-host targeting, and where to explore the schema. Surfaced from the
// nav + footer only when API keys are configured ([auth] api_keys).
import { LoomElement, component, styles, css, reactive, mount, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import { appBar } from "../app-bar";

@route("/api-docs")
@component("hope-api-docs")
@styles(css`
  :host { display: block; min-height: calc(100vh - 48px); background: var(--ink); }
  .bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: stretch; height: 44px;
    border-bottom: 1px solid var(--line); background: var(--ink); }
  .bar .s { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-right: 1px solid var(--line); }
  .bar .back { display: flex; align-items: center; gap: 5px; color: var(--dim); font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .back:hover { color: var(--hi); }
  .bar .grow { flex: 1; }
  .bar .act { padding: 0; border-left: 1px solid var(--line); }
  .bar .act button { height: 44px; padding: 0 16px; background: transparent; border: 0; color: var(--dim);
    font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .bar .act button:hover { color: var(--hi); background: var(--raised); }

  main { padding: 28px 40px 96px; max-width: 1340px; margin: 0 auto; }
  /* full-width page frame, but keep the docs readable in a centered column */
  .doc { max-width: 940px; margin: 0 auto; }

  .hero { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 22px; }
  .hero .t { display: block; font: 700 30px/1 var(--mono); letter-spacing: .06em; color: var(--hi); margin-bottom: 10px; }
  .hero .sub { display: block; max-width: 680px; font: 13px/1.6 var(--mono); color: var(--dim); }
  .hero .sub code { color: var(--mid); }

  .links { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 22px; }
  .lcard { display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); background: var(--panel);
    padding: 14px 16px; cursor: pointer; text-decoration: none; }
  .lcard:hover { border-color: var(--upd); }
  .lcard loom-icon { color: var(--upd); flex: none; }
  .lcard .lt { font: 600 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--hi); }
  .lcard .ld { font: 11.5px/1.4 var(--mono); color: var(--dim); margin-top: 4px; }
  .lcard .lb { flex: 1; min-width: 0; }
  .lcard .go { color: var(--dim); }

  .panel { border: 1px solid var(--line); background: var(--panel); margin-bottom: 14px; }
  .ph { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line);
    font: 600 11px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--hi); }
  .ph .n { color: var(--dim); }
  .pb { padding: 16px; }
  .pb p { font: 12.5px/1.7 var(--mono); color: var(--mid); margin: 0 0 12px; }
  .pb p:last-child { margin-bottom: 0; }
  .pb p code, .htable code { color: var(--upd); }

  .htable { display: flex; flex-direction: column; }
  .hrow { display: flex; gap: 18px; align-items: baseline; padding: 11px 0; border-bottom: 1px solid var(--line); }
  .hrow:first-child { padding-top: 0; }
  .hrow:last-child { border-bottom: 0; padding-bottom: 0; }
  .hrow .hk { flex: 0 0 240px; font: 12.5px/1.5 var(--mono); color: var(--hi); }
  .hrow .hk.req { color: var(--upd); }
  .hrow .hv { flex: 1; min-width: 0; font: 12px/1.6 var(--mono); color: var(--dim); }
  .hrow .hv code { color: var(--upd); }

  .code { position: relative; background: var(--ink); border: 1px solid var(--line); }
  .code pre { margin: 0; padding: 14px 15px; overflow-x: auto; font: 12px/1.7 var(--mono); color: var(--hi); white-space: pre; }
  .code .cp { position: absolute; top: 8px; right: 8px; display: inline-flex; align-items: center; gap: 6px;
    background: var(--raised); border: 1px solid var(--line2); color: var(--dim); cursor: pointer;
    font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; padding: 7px 10px; }
  .code .cp:hover { color: var(--hi); border-color: var(--mid); }
  .code .cp.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, var(--line)); }

  .note { font: 11.5px/1.6 var(--mono); color: var(--dim); margin-top: 12px; }
  .note b { color: var(--warn); font-weight: 600; }

  @media (max-width: 640px) { .links { grid-template-columns: 1fr; } }
`)
export class ApiDocsPage extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter { return app.get(LoomRouter); }
  @reactive accessor copied = "";

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) this.router.navigate("/login");
  }


  private get keyBlock(): string {
    return `[auth]\napi_keys = ["a-long-random-string"]`;
  }

  private get curl(): string {
    return [
      `curl -X POST ${location.origin}/rpc/Stacks/list \\`,
      `  -H "Authorization: Bearer $HOPE_API_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "X-Hope-Host: local" \\`,
      `  -d '{"args": []}'`,
    ].join("\n");
  }

  private get argForms(): string {
    return [
      `# named — an object matching the method's params`,
      `-d '{"args": {"id": "web-1"}}'`,
      ``,
      `# positional — a params-ordered array (what the UI sends)`,
      `-d '{"args": ["web-1"]}'`,
    ].join("\n");
  }

  private copy = async (text: string, tag: string) => {
    try { await navigator.clipboard.writeText(text); this.copied = tag; setTimeout(() => (this.copied = ""), 1400); } catch { /* blocked */ }
  };

  private codeBlock(tag: string, text: string) {
    return (
      <div class="code">
        <button class={"cp" + (this.copied === tag ? " ok" : "")} onClick={() => this.copy(text, tag)}><loom-icon name="copy" size={12}></loom-icon>{this.copied === tag ? "copied" : "copy"}</button>
        <pre>{text}</pre>
      </div>
    );
  }

  update() {
    return (
      <div>
        {appBar("api")}
        <main>
          <div class="doc">
          <div class="hero">
            <span class="t">API</span>
            <span class="sub">hope's UI runs on a plain RPC surface — <code>POST /rpc/&lt;Service&gt;/&lt;method&gt;</code>. An API key unlocks that same surface for scripts, CI and agents. No new API — it's the app's own contract.</span>
          </div>

          <div class="links">
            <a class="lcard" href="/rpc/_explorer/">
              <loom-icon name="terminal" size={18}></loom-icon>
              <span class="lb"><div class="lt">Explorer</div><div class="ld">browse + try every method</div></span>
              <loom-icon class="go" name="chevron-right" size={14}></loom-icon>
            </a>
            <a class="lcard" href="/rpc/_introspect" target="_blank" rel="noreferrer">
              <loom-icon name="copy" size={18}></loom-icon>
              <span class="lb"><div class="lt">Schema JSON</div><div class="ld">/rpc/_introspect — feed to codegen</div></span>
              <loom-icon class="go" name="chevron-right" size={14}></loom-icon>
            </a>
          </div>

          <div class="panel">
            <div class="ph"><span class="n">01</span> Get a key</div>
            <div class="pb">
              <p>Set one or more long random keys in hope's config, then restart. A key is root-equivalent over every host hope manages — keep it secret.</p>
              {this.codeBlock("key", this.keyBlock)}
            </div>
          </div>

          <div class="panel">
            <div class="ph"><span class="n">02</span> Headers</div>
            <div class="pb">
              <div class="htable">
                <div class="hrow"><span class="hk req">Authorization: Bearer &lt;key&gt;</span><span class="hv">Required. Your API key (or a session token).</span></div>
                <div class="hrow"><span class="hk req">Content-Type: application/json</span><span class="hv">Required.</span></div>
                <div class="hrow"><span class="hk">X-Hope-Host: &lt;host-id&gt;</span><span class="hv">Optional. Target one host for this call — <code>local</code> or an agent id from the Agents page. Omit to use the active host.</span></div>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="ph"><span class="n">03</span> Request shape</div>
            <div class="pb">
              <p>Method names are lower-first (<code>Stacks/list</code>, <code>Containers/inspect</code>). Arguments go in <code>args</code> — sov accepts either a <b>named object</b> matching the method's params or a <b>positional array</b>. (The UI uses positional; both hit the same handler.)</p>
              {this.codeBlock("curl", this.curl)}
              <p style="margin-top:14px">Both forms of <code>args</code> for <code>Containers/inspect</code>:</p>
              {this.codeBlock("args", this.argForms)}
            </div>
          </div>
          </div>
        </main>
      </div>
    );
  }
}
