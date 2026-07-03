// Shared secret-masking helpers. Docker surfaces (process argv, image history
// build steps, inspect env) routinely carry passwords/tokens in plaintext; these
// mask the obvious ones while keeping the text readable. Best-effort, not a
// guarantee — pair with an explicit "reveal" toggle on read-only views.

export const MASK = "•••••";

// SECRET_KEY matches object keys whose whole value is a secret (mask the value
// outright, not just embedded patterns) — used to redact the inspect dump.
export const SECRET_KEY = /(pass|passwd|password|secret|token|api[-_]?key|apikey|credential|pwd|private[-_]?key|access[-_]?key|auth)/i;

// redactCmd masks secret-looking values in a command line / build step: secret
// flags (--password=x, -p x), ENV assignments (FOO_TOKEN=x), URL credentials,
// and bearer/basic auth headers. The flag/key stays visible; only the value goes.
export function redactCmd(s: string): string {
  if (!s) return s;
  return s
    .replace(/(--?(?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|auth|credential|pwd|p)\b)(=|\s+)(\S+)/gi, (_m, f, sep) => `${f}${sep}${MASK}`)
    .replace(/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|PWD|CREDENTIAL)[A-Z0-9_]*=)(\S+)/gi, (_m, k) => `${k}${MASK}`)
    .replace(/(\/\/[^:/@\s]+:)([^@/\s]+)(@)/g, (_m, a, _p, c) => `${a}${MASK}${c}`)
    .replace(/(authorization:\s*(?:bearer|basic)\s+)(\S+)/gi, (_m, a) => `${a}${MASK}`);
}

// redactInspect returns a deep copy of a docker inspect object with secrets
// masked: values under secret-named keys are fully masked, every other string is
// run through redactCmd. Env is an array of "KEY=VALUE" strings, so those land
// in redactCmd too.
export function redactInspect(obj: any): any {
  const walk = (key: string, val: any): any => {
    if (typeof val === "string") return SECRET_KEY.test(key) ? MASK : redactCmd(val);
    if (Array.isArray(val)) return val.map((x) => walk(key, x));
    if (val && typeof val === "object") {
      const out: any = {};
      for (const k in val) out[k] = walk(k, val[k]);
      return out;
    }
    return val;
  };
  return walk("", obj);
}
