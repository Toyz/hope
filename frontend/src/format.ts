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
