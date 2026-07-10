// consumeOpStream drains a server op stream (Stream/* methods yield OpFrame) into
// an emit() sink and reports success. It is the loop that was copy-pasted ~15
// times: forward each "log" frame's line, and on a failed "done" frame flip the
// result and emit the error. `prefix` is prepended to every emitted line (some
// callers indent nested output with "  "). Reconnect/watchdog behavior stays in
// the caller — this is only the frame loop.
import type { OpFrame } from "./contracts";

export async function consumeOpStream(
  stream: AsyncIterable<OpFrame>,
  emit: (line: string) => void,
  opts: { prefix?: string } = {},
): Promise<boolean> {
  const p = opts.prefix ?? "";
  let ok = true;
  for await (const f of stream) {
    if (f.type === "log" && f.data) emit(p + f.data);
    else if (f.type === "done" && !f.ok) {
      ok = false;
      emit(p + "failed: " + (f.error ?? ""));
    }
  }
  return ok;
}
