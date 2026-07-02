// AuthStore persists the bearer token in localStorage so a reload keeps the
// session. Single-user app — one token, no refresh.
import { app } from "@toyz/loom";
import { LoomRouter } from "@toyz/loom/router";

const KEY = "hope.token";
const ACCESS_KEY = "hope.access"; // set when the session came from a Cloudflare Access SSO exchange

// Cloudflare Access intercepts this path on any Access-protected hostname and
// clears the edge session cookie — so a real logout drops hope's token AND the
// Access session that would otherwise silently re-authenticate us.
const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

export class AuthStore {
  private _token: string | null = localStorage.getItem(KEY);

  get token(): string | null {
    return this._token;
  }

  get isAuthenticated(): boolean {
    return !!this._token;
  }

  // True when this session was minted from a Cloudflare Access assertion (SSO),
  // so a real logout must also drop the Access cookie at the edge.
  get viaAccess(): boolean {
    return localStorage.getItem(ACCESS_KEY) === "1";
  }

  set(token: string, viaAccess = false): void {
    this._token = token;
    localStorage.setItem(KEY, token);
    if (viaAccess) localStorage.setItem(ACCESS_KEY, "1");
    else localStorage.removeItem(ACCESS_KEY);
  }

  clear(): void {
    this._token = null;
    localStorage.removeItem(KEY);
    localStorage.removeItem(ACCESS_KEY);
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
