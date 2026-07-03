// AuthStore persists the bearer token so a reload keeps the session. Single-user
// app — one token, no refresh. Persistence is loom's @persist (localStorage,
// JSON-serialized), same as HostContext — no hand-rolled storage.
import { app, persist } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";

// Cloudflare Access intercepts this path on any Access-protected hostname and
// clears the edge session cookie — so a real logout drops hope's token AND the
// Access session that would otherwise silently re-authenticate us.
const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

export class AuthStore {
  @persist("hope.token") private accessor _token: string | null = null;
  // Set when the session came from a Cloudflare Access SSO exchange.
  @persist("hope.access") private accessor _access = false;

  get token(): string | null {
    return this._token;
  }

  get isAuthenticated(): boolean {
    return !!this._token;
  }

  // True when this session was minted from a Cloudflare Access assertion (SSO),
  // so a real logout must also drop the Access cookie at the edge.
  get viaAccess(): boolean {
    return !!this._access;
  }

  set(token: string, viaAccess = false): void {
    this._token = token;
    this._access = viaAccess;
  }

  clear(): void {
    this._token = null;
    this._access = false;
  }

  // User-initiated logout. Drops the hope token; if the session came in through
  // Cloudflare Access, redirect to the edge logout so the still-valid JWT doesn't
  // just sign us back in. returnTo the app root so the edge immediately re-issues
  // a fresh Access challenge (a clean re-login) instead of parking on CF's logout
  // page. Otherwise return to the login form.
  logout(): void {
    const wasAccess = this.viaAccess;
    this.clear();
    if (wasAccess) {
      window.location.href = `${ACCESS_LOGOUT}?returnTo=${encodeURIComponent(location.origin + "/")}`;
      return;
    }
    app.get(LoomRouter).navigate("/login");
  }
}
