// parseStats — turn one docker stats frame into display values. The CPU delta
// math and cache-adjusted memory live here once, shared by the container
// inspector (and the container page until it's retired) instead of duplicated.
import { bytes } from "./format";

const mb = bytes; // memory readouts share the canonical base-1024 formatter

export interface Stat {
  cpu: string;     // "12.3%"
  cpuBar: number;  // 0..100
  mem: string;     // "128 MB / 512 MB" (combined, for the inspector)
  memUsed: string; // "128 MB"
  memLimit: string; // "512 MB"
  memBar: number;  // 0..100
  rx: string;      // rx bytes, humanized
  tx: string;
  blkR: string;    // block-io read bytes, humanized
  blkW: string;
}

export function parseStats(s: any): Partial<Stat> {
  const out: Partial<Stat> = {};
  try {
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
    const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
    const cpus = s.cpu_stats.online_cpus || (s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1);
    if (sysDelta > 0 && cpuDelta >= 0) {
      out.cpu = ((cpuDelta / sysDelta) * cpus * 100).toFixed(1) + "%";
      out.cpuBar = Math.min(100, (cpuDelta / sysDelta) * 100);
    }
    // Working set = usage minus page cache, matching `docker stats`. cgroup v1
    // exposes it as stats.cache; cgroup v2 has no `cache` key — it's
    // inactive_file. Missing either → subtract 0 (shows usage incl. cache).
    const cache = s.memory_stats.stats?.cache ?? s.memory_stats.stats?.inactive_file ?? 0;
    const used = (s.memory_stats.usage ?? 0) - cache;
    const limit = s.memory_stats.limit ?? 0;
    out.memUsed = mb(used);
    out.memLimit = mb(limit);
    out.mem = mb(used) + (limit ? " / " + mb(limit) : "");
    out.memBar = limit ? Math.min(100, (used / limit) * 100) : 0;
    let rx = 0;
    let tx = 0;
    for (const n of Object.values<any>(s.networks ?? {})) { rx += n.rx_bytes ?? 0; tx += n.tx_bytes ?? 0; }
    out.rx = bytes(rx);
    out.tx = bytes(tx);
    let r = 0;
    let w = 0;
    for (const e of s.blkio_stats?.io_service_bytes_recursive ?? []) {
      if (e.op === "Read" || e.op === "read") r += e.value ?? 0;
      if (e.op === "Write" || e.op === "write") w += e.value ?? 0;
    }
    out.blkR = bytes(r);
    out.blkW = bytes(w);
  } catch { /* partial frame */ }
  return out;
}
