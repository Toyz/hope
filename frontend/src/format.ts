// Shared formatting helpers — extracted from the per-page copies that had
// drifted (byte formatters, port parsing, id truncation).

// Human byte size, base-1024 (B..TB). Negative -> "—", zero -> "0 B".
export function bytes(n: number): string {
  if (n < 0) return "—";
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Internal (container-side) port from a docker port string
// ("127.0.0.1:8080->8080/tcp" -> "8080", "9000/tcp" -> "9000").
export function innerPort(p: string): string {
  const arrow = p.indexOf("->");
  return (arrow >= 0 ? p.slice(arrow + 2) : p).split("/")[0].trim();
}

// Short id: strip a sha256: prefix and truncate to 12 chars.
export function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

// flatten walks an object into [dottedPath, leafValue] rows. Nested objects and
// arrays become dotted/indexed paths so every value is one table row.
export function flatten(obj: any, prefix = ""): [string, any][] {
  const rows: [string, any][] = [];
  const entries: [string, any][] = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj ?? {});
  for (const [k, v] of entries) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      if (v.length === 0) rows.push([path, "(empty list)"]);
      else if (v.every((x) => x === null || typeof x !== "object")) {
        // array of primitives → one joined row instead of .0 / .1 / .2
        rows.push([path, v.map((x) => (x === null ? "null" : String(x))).join(", ")]);
      } else {
        // array of objects → one summarized row per element, not a field explosion
        v.forEach((el, idx) => {
          if (el !== null && typeof el === "object") rows.push([`${path}.${idx}`, summarize(el)]);
          else rows.push([`${path}.${idx}`, el]);
        });
      }
    } else if (v !== null && typeof v === "object") {
      if (Object.keys(v).length === 0) rows.push([path, "(empty)"]);
      else rows.push(...flatten(v, path));
    } else {
      rows.push([path, v]);
    }
  }
  return rows;
}

// summarize collapses an object into a one-line "k=v · k=v" summary of its
// primitive fields — used for array-of-object rows (e.g. each Mount).
export function summarize(obj: any): string {
  const parts = Object.entries(obj)
    .filter(([, x]) => x === null || typeof x !== "object")
    .map(([k, x]) => `${k}=${x === null ? "null" : x}`);
  return parts.join("  ·  ") || "{…}";
}

// Split docker's leading RFC3339 timestamp (from Timestamps:true) off a log line
// and humanize it to HH:MM:SS. Returns {ts:"", msg} when the line isn't stamped.
// Shared by the container inspector's logs tab and the multi-source log viewer so
// both read the same.
export function parseLogLine(line: string): { ts: string; msg: string } {
  const s = line.replace(/\n$/, "");
  const sp = s.indexOf(" ");
  if (sp > 0) {
    const d = new Date(s.slice(0, sp));
    if (!isNaN(d.getTime())) {
      const p = (n: number) => String(n).padStart(2, "0");
      return { ts: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, msg: s.slice(sp + 1) };
    }
  }
  return { ts: "", msg: s };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Friendly calendar time from an ISO string ("Jul 4 2026, 08:36 UTC") — readable
// instead of the raw docker timestamp. "" if unset or a docker zero-time.
export function friendlyTime(iso?: string): string {
  if (!iso || iso.startsWith("0001")) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// Coarse uptime from an ISO start time ("3d 4h", "5h 12m", "8m"). "—" if unset
// or a docker zero-time ("0001-...").
export function uptime(startedAt?: string): string {
  if (!startedAt || startedAt.startsWith("0001")) return "—";
  const t = new Date(startedAt).getTime();
  if (!t) return "—";
  let s = Math.max(0, (Date.now() - t) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
