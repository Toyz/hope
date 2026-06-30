// Login — a terminal prompt. One credential exchanged for a bearer token.
import { LoomElement, component, styles, css, reactive, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { route, LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import type { LoginResult } from "../contracts";
import { theme } from "../styles";

@route("/login")
@component("hope-login")
@styles(css`
  ${theme}
  :host { display: grid; place-items: center; min-height: 100vh; background: var(--ink); }
  .card { width: 320px; border: 1px solid var(--line); padding: 28px 26px; }
  .brand { font: 700 16px/1 var(--mono); letter-spacing: .3em; }
  .sub { font: 11px/1 var(--mono); color: var(--dim); letter-spacing: .14em; text-transform: uppercase; margin-top: 8px; }
  .strip { display: flex; gap: 2px; height: 6px; margin: 18px 0 24px; }
  .strip i { flex: 1; background: var(--faint); }
  .strip i:nth-child(4n) { background: #244B39; }

  label { display: block; font: 600 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .18em;
    color: var(--dim); margin: 16px 0 7px; }
  input { width: 100%; padding: 10px 12px; background: var(--panel); color: var(--hi);
    border: 1px solid var(--line); border-radius: 0; font: 13px/1 var(--mono); }
  input:focus { outline: none; border-color: var(--line2); }
  button { width: 100%; margin-top: 22px; padding: 11px; background: transparent; color: var(--hi);
    border: 1px solid var(--line2); border-radius: 0; font: 600 12px/1 var(--mono); letter-spacing: .16em;
    text-transform: uppercase; cursor: pointer; transition: background .1s; }
  button:hover { background: var(--raised); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .err { color: var(--bad); margin-top: 14px; min-height: 18px; font: 12px/1.4 var(--mono); }
`)
export class LoginPage extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  private get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  @reactive accessor username = "";
  @reactive accessor password = "";
  @reactive accessor error = "";
  @reactive accessor busy = false;

  private submit = async (e: Event) => {
    e.preventDefault();
    this.error = "";
    this.busy = true;
    try {
      const res = await this.rpc.call<LoginResult>("Auth", "login", [this.username, this.password]);
      this.auth.set(res.token);
      this.router.navigate("/");
    } catch (err: any) {
      this.error = err?.message ?? "Sign in failed.";
    } finally {
      this.busy = false;
    }
  };

  update() {
    return (
      <form class="card" onSubmit={this.submit}>
        <div class="brand">HOPE</div>
        <div class="sub">cluster control</div>
        <div class="strip">
          {Array.from({ length: 20 }).map(() => (
            <i></i>
          ))}
        </div>
        <label>Username</label>
        <input type="text" value={this.username} autocomplete="username" onInput={(e: any) => (this.username = e.target.value)} />
        <label>Password</label>
        <input type="password" value={this.password} autocomplete="current-password" onInput={(e: any) => (this.password = e.target.value)} />
        <button type="submit" disabled={this.busy}>{this.busy ? "…" : "Sign in"}</button>
        <div class="err">{this.error}</div>
      </form>
    );
  }
}
