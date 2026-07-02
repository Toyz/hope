// topbar is a shared JSX builder (not a component) used by the authed pages.
import { AuthStore } from "./auth-store";
import type { LoomRouter } from "@toyz/loom/router";

export function topbar(opts: { auth: AuthStore; router: LoomRouter; title?: string }) {
  const logout = () => opts.auth.logout();
  return (
    <div class="topbar">
      <div class="row">
        <loom-link to="/" class="brand">hope</loom-link>
        {opts.title ? <span class="muted">/ {opts.title}</span> : null}
      </div>
      <button onClick={logout}>Logout</button>
    </div>
  );
}
