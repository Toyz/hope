// ResourcePage — shared spine for the near-identical resource list pages
// (networks, volumes): the DI wiring, the busy/error/query/detail/selection
// state, the selection mechanics, the fleet flag, and the mount/host-change
// lifecycle. Subclasses supply the type-specific parts: the item list accessor,
// load()/loadFleet(), the selection key(), visible() filtering, and render.
//
// Images is deliberately NOT built on this — it diverges too far (id/sha
// selection, prune, redeploy-&-free, multi-host prune).
import { LoomElement, reactive, mount, on, app } from "@toyz/loom";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { HopeTransport } from "../transport";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { ConfirmService } from "../confirm";
import { PromptService } from "../prompt";
import { ToastService } from "../toast";
import { ProcService } from "../proc";
import { HostChanged } from "../events";
import type { ResourceUser } from "../contracts";

export abstract class ResourcePage<T extends { used_by: ResourceUser[] }> extends LoomElement {
  @inject(HopeTransport) accessor rpc!: HopeTransport;
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HostContext) accessor hostCtx!: HostContext;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(ProcService) accessor proc!: ProcService;

  @reactive accessor busy = false;
  @reactive accessor error = "";
  @reactive accessor query = "";
  @reactive accessor detail: (T & { host?: string }) | null = null;
  @reactive accessor selected: string[] = []; // selection keys (removable items only)

  protected get router(): LoomRouter {
    return app.get(LoomRouter);
  }

  get fleetMode(): boolean {
    return this.hostCtx.fleet;
  }

  @mount
  onMount() {
    if (!this.auth.isAuthenticated) {
      this.router.navigate("/login");
      return;
    }
    this.load();
  }

  // Host/fleet switched elsewhere — re-fetch in place (no reload).
  @on(HostChanged)
  onHostChanged() {
    if (this.auth.isAuthenticated) this.load();
  }

  // Only unused items are selectable for bulk removal.
  protected removable(): (T & { host?: string })[] {
    return this.visible().filter((x) => !x.used_by.length);
  }

  toggleSel = (k: string, e: Event) => {
    e.stopPropagation();
    this.selected = this.selected.includes(k) ? this.selected.filter((x) => x !== k) : [...this.selected, k];
  };

  selectAllVisible = () => {
    const keys = this.removable().map((x) => this.key(x));
    this.selected =
      keys.length > 0 && keys.every((k) => this.selected.includes(k))
        ? this.selected.filter((k) => !keys.includes(k))
        : Array.from(new Set([...this.selected, ...keys]));
  };

  clearSel = () => (this.selected = []);

  // ── subclass hooks ──
  protected abstract load(): void | Promise<void>;
  protected abstract key(item: T & { host?: string }): string;
  protected abstract visible(): (T & { host?: string })[];
}
