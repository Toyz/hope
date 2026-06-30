// Login — a terminal prompt. One credential exchanged for a bearer token.
import { LoomElement, component, styles, css, reactive, mount, unmount, app } from "@toyz/loom";
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
  :host { display: grid; place-items: center; min-height: 100vh; background: var(--ink); overflow: hidden; }
  /* an absurd, over-engineered matrix-rain canvas behind the form. for no reason. */
  canvas.bg { position: fixed; inset: 0; z-index: 0; opacity: .8; }
  .card { position: relative; z-index: 1; width: 320px; border: 1px solid var(--line2);
    padding: 28px 26px; background: color-mix(in srgb, var(--panel) 86%, transparent); backdrop-filter: blur(2px); }
  .brand { font: 700 16px/1 var(--mono); letter-spacing: .3em; }
  .sub { font: 11px/1 var(--mono); color: var(--dim); letter-spacing: .14em; text-transform: uppercase; margin-top: 8px; }
  .strip { display: flex; gap: 2px; height: 6px; margin: 18px 0 24px; }
  .strip i { flex: 1; background: var(--faint); }
  .strip i.ok { background: var(--ok); }
  .strip i.warn { background: var(--warn); }
  .strip i.bad { background: var(--bad); }
  .strip i[data-tip] { cursor: help; }

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
  @reactive accessor nodes: { name: string; status: string; note: string }[] = [];

  private raf = 0;
  private onResize: (() => void) | null = null;

  @mount
  async onMount() {
    this.startMatrix();
    // The strip reflects the "status" of some very important infrastructure.
    try {
      this.nodes = await this.rpc.call("Meme", "nodes", []);
    } catch {
      /* the joke is optional */
    }
  }

  @unmount
  onUnmount() {
    cancelAnimationFrame(this.raf);
    if (this.onResize) removeEventListener("resize", this.onResize);
  }

  // A full digital-rain renderer. On a login screen. Because we could.
  private startMatrix() {
    const c = this.shadowRoot?.querySelector("canvas.bg") as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; // be reasonable, occasionally

    const font = 16;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cols = 0;
    let drops: number[] = [];
    const resize = () => {
      c.width = innerWidth * dpr;
      c.height = innerHeight * dpr;
      c.style.width = innerWidth + "px";
      c.style.height = innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(innerWidth / font);
      drops = Array.from({ length: cols }, () => Math.random() * -60);
    };
    resize();
    this.onResize = resize;
    addEventListener("resize", resize);

    const chars = "アァカサタナハマヤラワabcdef0123456789{}[]<>/$#".split("");
    const draw = () => {
      ctx.fillStyle = "rgba(10,12,17,0.07)";
      ctx.fillRect(0, 0, innerWidth, innerHeight);
      ctx.font = `${font}px ui-monospace, monospace`;
      for (let i = 0; i < cols; i++) {
        const ch = chars[(Math.random() * chars.length) | 0];
        const x = i * font;
        const y = drops[i] * font;
        ctx.fillStyle = Math.random() > 0.98 ? "rgba(150,235,180,0.9)" : "rgba(46,120,80,0.4)";
        ctx.fillText(ch, x, y);
        if (y > innerHeight && Math.random() > 0.975) drops[i] = 0;
        else drops[i] += 0.5;
      }
      this.raf = requestAnimationFrame(draw);
    };
    draw();
  }

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
      <>
        <canvas class="bg"></canvas>
        <form class="card" onSubmit={this.submit}>
        <div class="brand">HOPE</div>
        <div class="sub">cluster control</div>
        <div class="strip">
          {(this.nodes.length ? this.nodes : Array.from({ length: 24 }, () => null)).map((n: any) => (
            <i class={n?.status ?? ""} data-tip={n ? `${n.name} · ${n.note}` : undefined}></i>
          ))}
        </div>
        <label>Username</label>
        <input type="text" value={this.username} autocomplete="username" onInput={(e: any) => (this.username = e.target.value)} />
        <label>Password</label>
        <input type="password" value={this.password} autocomplete="current-password" onInput={(e: any) => (this.password = e.target.value)} />
        <button type="submit" disabled={this.busy}>{this.busy ? "…" : "Sign in"}</button>
        <div class="err">{this.error}</div>
        </form>
      </>
    );
  }
}
