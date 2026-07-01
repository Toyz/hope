// <hope-toast> — the shared toast surface. ToastService creates one on the body
// and calls show(); it queues transient messages (bottom-right) that auto-dismiss.
import { LoomElement, component, styles, css, reactive } from "@toyz/loom";
import { theme } from "../styles";

interface Toast {
  id: number;
  msg: string;
  kind: string; // "" | "ok" | "warn" | "bad"
}

@component("hope-toast")
@styles(css`
  ${theme}
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

  show(msg: string, kind = "") {
    const id = ++this.seq;
    this.items = [...this.items, { id, msg, kind }];
    setTimeout(() => {
      this.items = this.items.filter((t) => t.id !== id);
    }, 2800);
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
