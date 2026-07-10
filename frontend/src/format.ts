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

// Strip ANSI color/escape sequences so colored logger output renders cleanly.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

// ago — compact relative time ("just now", "5m", "3h", "2d", "3mo", "1y"). "—"
// when the timestamp is missing/unparseable. Shared by the resource + agent lists.
export function ago(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo`;
  return `${Math.floor(s / 31536000)}y`;
}

// ageUnix — like ago() but from a UNIX-SECONDS timestamp and with no "just now"
// (shows minutes at the low end): "5m"/"3h"/"2d"/"3mo"/"1y", "—" if unset. Shared
// by the image inspector and images list, which had byte-identical copies.
export function ageUnix(unix: number): string {
  if (!unix) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  const d = Math.floor(s / 86400);
  if (d >= 1) return d >= 365 ? `${Math.floor(d / 365)}y` : d >= 30 ? `${Math.floor(d / 30)}mo` : `${d}d`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.floor(s / 60)}m`;
}

// kvParse / kvSerialize — the shared env-var text<->rows codec (split on the first
// "=", skip blank/`#` lines). The KEY is trimmed; the VALUE is preserved verbatim
// so meaningful leading/trailing spaces in a value survive a round-trip.
export interface KvPair { k: string; v: string }
export function kvParse(s: string): KvPair[] {
  const out: KvPair[] = [];
  for (const line of (s || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) out.push({ k: t, v: "" });
    else out.push({ k: t.slice(0, i).trim(), v: t.slice(i + 1) });
  }
  return out;
}
export function kvSerialize(rows: KvPair[]): string {
  return rows.filter((r) => r.k.trim()).map((r) => `${r.k.trim()}=${r.v}`).join("\n");
}

// ansiToSegments — the inverse of stripAnsi: parse ANSI SGR escapes into styled
// text segments so colored logger output can render in color when the viewer opts
// in. Handles the common 8/16 foreground + background + bold/reset codes; unknown
// codes are ignored. Each segment is plain text plus an inline style string ("" =
// default). Colors track the theme's log palette.
export interface AnsiSeg { text: string; style: string }
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g;
const ANSI_FG: Record<number, string> = {
  30: "#3b3f46", 31: "#f7768e", 32: "#9ece6a", 33: "#e0af68", 34: "#7aa2f7", 35: "#bb9af7", 36: "#7dcfff", 37: "#c0caf5",
  90: "#5c6370", 91: "#ff7a93", 92: "#b9f27c", 93: "#ff9e64", 94: "#7da6ff", 95: "#c8a2ff", 96: "#a4dbff", 97: "#ffffff",
};
const ANSI_BG: Record<number, string> = {
  40: "#3b3f46", 41: "#f7768e", 42: "#9ece6a", 43: "#e0af68", 44: "#7aa2f7", 45: "#bb9af7", 46: "#7dcfff", 47: "#c0caf5",
};
export function ansiToSegments(s: string): AnsiSeg[] {
  const out: AnsiSeg[] = [];
  let fg = "", bg = "", bold = false;
  const push = (text: string) => {
    if (!text) return;
    const style = [fg && `color:${fg}`, bg && `background:${bg}`, bold && "font-weight:600"].filter(Boolean).join(";");
    out.push({ text, style });
  };
  let last = 0;
  let m: RegExpExecArray | null;
  SGR.lastIndex = 0;
  while ((m = SGR.exec(s))) {
    push(s.slice(last, m.index));
    last = SGR.lastIndex;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (const c of codes) {
      if (c === 0) { fg = ""; bg = ""; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) fg = "";
      else if (c === 49) bg = "";
      else if (ANSI_FG[c]) fg = ANSI_FG[c];
      else if (ANSI_BG[c]) bg = ANSI_BG[c];
    }
  }
  push(s.slice(last));
  return out;
}
