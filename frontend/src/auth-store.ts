// AuthStore persists the bearer token in localStorage so a reload keeps the
// session. Single-user app — one token, no refresh.
const KEY = "hope.token";

export class AuthStore {
  private _token: string | null = localStorage.getItem(KEY);

  get token(): string | null {
    return this._token;
  }

  get isAuthenticated(): boolean {
    return !!this._token;
  }

  set(token: string): void {
    this._token = token;
    localStorage.setItem(KEY, token);
  }

  clear(): void {
    this._token = null;
    localStorage.removeItem(KEY);
  }
}
