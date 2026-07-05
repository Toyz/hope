// ResourcePage — shared spine for the resource list pages (networks, volumes,
// images). Owns the selection + detail state, the selection mechanics, and the
// lifecycle. Data itself lives in each subclass as @rpc query accessors
// (ApiState) so refetches are SWR — the previous list stays on screen while the
// new one loads, no blank/pop. The subclass exposes it through items()/loading()
// and re-fetches via refresh().
//
// Host/fleet targeting is ambient: HostContext (a reactive @persist store) holds
// the active host + fleet flag; the transport reads the host, and @watch on the
// store re-fetches when either changes — no manual event.
import { LoomElement, reactive, mount, unmount, on, watch, app } from "@toyz/loom";
import { signalModal } from "../modal";
import { inject } from "@toyz/loom/di";
import { LoomRouter } from "@toyz/loom/router";
import { AuthStore } from "../auth-store";
import { HostContext } from "../host-context";
import { ConfirmService } from "../confirm";
import { PromptService } from "../prompt";
import { ToastService } from "../toast";
import { ProcService } from "../proc";
import { HostChanged, Refreshing, withRefresh } from "../events";
import type { ResourceUser } from "../contracts";

export abstract class ResourcePage<T extends { used_by: ResourceUser[] }> extends LoomElement {
  @inject(AuthStore) accessor auth!: AuthStore;
  @inject(HostContext) accessor hostCtx!: HostContext;
  @inject(ConfirmService) accessor confirm!: ConfirmService;
  @inject(PromptService) accessor prompt!: PromptService;
  @inject(ToastService) accessor toast!: ToastService;
  @inject(ProcService) accessor proc!: ProcService;

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
    this.refresh();
  }

  // The active host or fleet flag changed (HostContext emits) — re-fetch.
  @on(HostChanged)
  private onHostChanged() {
    if (this.auth.isAuthenticated) this.refresh();
  }

  // Spin the header refresh action only while an actual refresh is in flight —
  // driven by the shared Refreshing bus (ref-counted, min-beat), NOT the raw
  // loading flag (which a background poll keeps true → looks stuck). Bind the
  // refresh button's spin to `refreshing` and call `userRefresh` on click.
  @reactive accessor refreshing = false;
  private refreshRC = 0;
  @on(Refreshing) private onRefreshing(e: Refreshing) {
    this.refreshRC = Math.max(0, this.refreshRC + (e.active ? 1 : -1));
    this.refreshing = this.refreshRC > 0;
  }
  userRefresh = () => { void withRefresh(() => this.refresh()); };

  // Lock body scroll while the detail modal is open (all resource pages share it).
  @watch("detail") private lockBody() { signalModal(this, !!this.detail); }
  @unmount private releaseBody() { signalModal(this, false); }

  // Only unused items are selectable for bulk removal.
  protected removable(): (T & { host?: string })[] {
    return this.visible().filter((x) => !x.used_by.length);
  }

  toggleSel = (k: string, e: Event) => {
    e.stopPropagation();
    this.selected = this.selected.includes(k) ? this.selected.filter((x) => x !== k) : [...this.selected, k];
  };

  selectAllVisible = (e?: Event) => {
    e?.stopPropagation();
    const keys = this.removable().map((x) => this.key(x));
    this.selected =
      keys.length > 0 && keys.every((k) => this.selected.includes(k))
        ? this.selected.filter((k) => !keys.includes(k))
        : Array.from(new Set([...this.selected, ...keys]));
  };

  clearSel = () => (this.selected = []);

  // ── subclass hooks ──
  protected abstract refresh(): void; // refetch the active @rpc query
  protected abstract items(): (T & { host?: string })[]; // current list (query .data, normalized)
  protected abstract loading(): boolean; // active query .loading
  protected abstract key(item: T & { host?: string }): string;
  protected abstract visible(): (T & { host?: string })[];
}
