// <hope-toast> — the shared toast surface. ToastService creates one on the body
// and calls show(); it queues transient messages (bottom-right) that auto-dismiss.
// A sticky toast skips the timer and stays until replace()d or dismiss()ed — used
// for "doing X…" that resolves into "X done" (ToastService.progress()).
import { LoomElement, component, styles, css, reactive } from "@toyz/loom";
import { theme } from "../styles";

interface Toast {
  id: number;
  msg: string;
  kind: string; // "" | "ok" | "warn" | "bad"
}

const LIFE = 2800;

@component("hope-toast")
@styles(theme, css`
  .wrap { position: fixed; right: 22px; bottom: 22px; z-index: 2000; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
  .toast { background: var(--raised); border: 1px solid var(--line2); color: var(--hi);
    font: 500 12.5px/1.4 var(--mono); padding: 11px 15px; max-width: 420px;
    animation: tin .14s ease both; }
  @keyframes tin { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .toast.ok { border-color: color-mix(in srgb, var(--ok) 50%, var(--line2)); }
  .toast.warn { border-color: var(--warn); color: var(--warn); }
  .toast.bad { border-color: var(--bad); color: var(--bad); }
`)
export class ToastHost extends LoomElement {
  @reactive accessor items: Toast[] = [];
  private seq = 0;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  // Show a toast; returns its id. Sticky toasts skip the auto-dismiss timer.
  show(msg: string, kind = "", sticky = false): number {
    const id = ++this.seq;
    this.items = [...this.items, { id, msg, kind }];
    if (!sticky) this.arm(id);
    return id;
  }

  // Replace an existing toast's text/kind in place (keeps its slot); re-arms the
  // auto-dismiss unless sticky — so a sticky "doing…" becomes an auto-dismissing
  // "done". No-op if the toast already dismissed.
  replace(id: number, msg: string, kind = "", sticky = false) {
    if (!this.items.some((t) => t.id === id)) return;
    this.items = this.items.map((t) => (t.id === id ? { ...t, msg, kind } : t));
    this.clearTimer(id);
    if (!sticky) this.arm(id);
  }

  dismiss(id: number) {
    this.clearTimer(id);
    this.items = this.items.filter((t) => t.id !== id);
  }

  private arm(id: number) {
    this.timers.set(id, setTimeout(() => this.dismiss(id), LIFE));
  }
  private clearTimer(id: number) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  update() {
    if (this.items.length === 0) return document.createComment("");
    return (
      <div class="wrap">
        {this.items.map((t) => (
          <div class={"toast " + t.kind}>{t.msg}</div>
        ))}
      </div>
    );
  }
}
