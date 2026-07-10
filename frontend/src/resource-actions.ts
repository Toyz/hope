// Shared docked-inspector actions. The volume / network / (detail-modal) removers
// were near-identical (confirm -> busy -> callOn -> toast -> onChange+close ->
// catch -> unbusy), diverging only in the RPC method, id arg, message, and stats —
// the exact "same shape, small drift" the dedup audit flagged. One implementation.
import type { ConfirmService } from "./confirm";
import type { ToastService } from "./toast";
import type { HopeTransport } from "./transport";

interface RemoveDeps {
  confirm: ConfirmService;
  rpc: HopeTransport;
  toast: ToastService;
  onDone?: () => void; // e.g. insp.onChange
  close: () => void; // e.g. insp.close
  setBusy: (b: boolean) => void;
}

interface RemoveSpec {
  kind: string; // "volume" | "network" — labels the confirm + the first stat
  name: string;
  host: string;
  method: string; // System RPC: "removeVolume" | "removeNetwork"
  args: unknown[];
  message: string;
  stats?: { label: string; value: string }[]; // extra figures (e.g. bytes freed)
}

// removeResource confirms a destructive resource removal, runs it on the target host,
// and closes the inspector on success — the shared body behind removeVol/removeNet.
export async function removeResource(d: RemoveDeps, s: RemoveSpec): Promise<void> {
  const ok = await d.confirm.ask({
    title: `remove ${s.kind}`,
    danger: true,
    confirmLabel: "Remove",
    message: s.message,
    stats: [{ label: s.kind, value: s.name }, ...(s.host ? [{ label: "host", value: s.host }] : []), ...(s.stats ?? [])],
  });
  if (!ok) return;
  d.setBusy(true);
  try {
    await d.rpc.callOn(s.host, "System", s.method, s.args);
    d.toast.ok(`removed ${s.name}`);
    d.onDone?.();
    d.close();
  } catch (e: any) {
    d.toast.error(`remove — ${e?.message ?? "failed"}`);
  } finally {
    d.setBusy(false);
  }
}
