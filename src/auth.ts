/**
 * Cognito hosted-UI sign-in: Authorization Code + PKCE (S256). Public client, no secret.
 *
 * Token handling (spec §7.1): the ACCESS token lives in memory only. It is never
 * written to localStorage, logged, or put in a URL. We deliberately request no
 * refresh token handling in the browser (AWS advises against keeping refresh
 * tokens client-side); when the access token expires the user is sent back to the
 * hosted UI, whose own session usually signs them in again without a prompt.
 * Only the short-lived PKCE verifier and `state` are kept, in sessionStorage,
 * for the single redirect round-trip, then removed.
 */
export interface AuthConfig {
  domain: string;       // https://<prefix>.auth.<region>.amazoncognito.com
  clientId: string;
  redirectUri: string;
  scope: string;        // "openid email english-flashcards/progress"
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomString(byteLength = 32): string {
  const a = new Uint8Array(byteLength);
  crypto.getRandomValues(a);
  return base64url(a);
}

export async function makeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(cfg: AuthConfig, state: string, challenge: string): string {
  const u = new URL(cfg.domain + "/oauth2/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export type CallbackResult =
  | { ok: true; code: string }
  | { ok: false; reason: "none" | "state-mismatch" | "provider-error" };

export function parseCallback(search: string, expectedState: string | null): CallbackResult {
  const p = new URLSearchParams(search);
  if (!p.has("code") && !p.has("error")) return { ok: false, reason: "none" };
  if (!expectedState || p.get("state") !== expectedState) return { ok: false, reason: "state-mismatch" };
  if (p.has("error")) return { ok: false, reason: "provider-error" };
  return { ok: true, code: p.get("code")! };
}

export function tokenRequestBody(cfg: AuthConfig, code: string, verifier: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
}

/** Treat a token within 30s of expiry as already expired. */
export function isExpired(expiresAtMs: number, nowMs: number): boolean {
  return expiresAtMs - nowMs < 30_000;
}

const K_STATE = "ef_oauth_state";
const K_VERIFIER = "ef_oauth_verifier";

export interface Session {
  accessToken: string;
  expiresAt: number;
}

let session: Session | null = null;
export const getSession = (): Session | null => session;

export async function startLogin(cfg: AuthConfig): Promise<void> {
  const state = randomString(16);
  const verifier = randomString(48);
  sessionStorage.setItem(K_STATE, state);
  sessionStorage.setItem(K_VERIFIER, verifier);
  location.assign(buildAuthorizeUrl(cfg, state, await makeChallenge(verifier)));
}

/** Call once on page load. Completes a login redirect if one is in progress. */
export async function completeLogin(
  cfg: AuthConfig,
  fetchFn: typeof fetch = fetch,
): Promise<"signed-in" | "none" | "failed"> {
  const expected = sessionStorage.getItem(K_STATE);
  const verifier = sessionStorage.getItem(K_VERIFIER);
  const cb = parseCallback(location.search, expected);
  if (!cb.ok && cb.reason === "none") return "none";
  // Single use: clear regardless of outcome so a replayed URL can't be reused.
  sessionStorage.removeItem(K_STATE);
  sessionStorage.removeItem(K_VERIFIER);
  history.replaceState(null, "", location.pathname);   // strip ?code=&state= from the URL
  if (!cb.ok || !verifier) return "failed";
  try {
    const r = await fetchFn(cfg.domain + "/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenRequestBody(cfg, cb.code, verifier),
    });
    if (!r.ok) return "failed";
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token || !j.expires_in) return "failed";
    session = { accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return "signed-in";
  } catch {
    return "failed";
  }
}

export function signOut(cfg: AuthConfig): void {
  session = null;   // clear memory first
  const u = new URL(cfg.domain + "/logout");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("logout_uri", cfg.redirectUri);
  location.assign(u.toString());
}
