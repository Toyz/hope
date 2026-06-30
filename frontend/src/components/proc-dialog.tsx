// <hope-proc> — the eager, tiny lazy STUB for the processing dialog. @lazy
// defers the real impl chunk (proc-dialog-impl) until the element first mounts;
// loom queues any run() call made before the chunk lands and replays it.
import { LoomElement, component } from "@toyz/loom";
import { lazy } from "@toyz/loom/element";

// The worker for ProcService.run: receives emit() for progress lines and an
// AbortSignal (Close aborts it). Return false (or throw) to mark the run failed.
export type ProcFn = (emit: (line: string) => void, signal: AbortSignal) => Promise<boolean | void>;

@component("hope-proc")
@lazy(() => import("./proc-dialog-impl"))
export class ProcDialog extends LoomElement {}
