// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  base64url, makeChallenge, buildAuthorizeUrl, parseCallback, tokenRequestBody,
  isExpired, type AuthConfig,
} from "../src/auth";

const cfg: AuthConfig = {
  domain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  clientId: "client123",
  redirectUri: "https://site.example/",
  scope: "openid email english-flashcards/progress",
};

describe("PKCE", () => {
  it("base64url has no +, / or = padding", () => {
    const s = base64url(new Uint8Array([251, 255, 254, 62, 63]));
    expect(s).not.toMatch(/[+/=]/);
  });

  it("S256 challenge matches the RFC 7636 test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await makeChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("authorize URL", () => {
  it("uses code flow with S256, state, and the required scope", () => {
    const u = new URL(buildAuthorizeUrl(cfg, "STATE1", "CHAL1"));
    expect(u.origin + u.pathname).toBe(cfg.domain + "/oauth2/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL1");
    expect(u.searchParams.get("state")).toBe("STATE1");
    expect(u.searchParams.get("scope")).toContain("english-flashcards/progress");
    expect(u.searchParams.get("client_id")).toBe("client123");
  });
});

describe("callback parsing (state validation)", () => {
  it("returns the code when state matches", () => {
    expect(parseCallback("?code=abc&state=S1", "S1")).toEqual({ ok: true, code: "abc" });
  });
  it("rejects a mismatched state", () => {
    expect(parseCallback("?code=abc&state=EVIL", "S1")).toEqual({ ok: false, reason: "state-mismatch" });
  });
  it("rejects a missing expected state (no pending login)", () => {
    expect(parseCallback("?code=abc&state=S1", null)).toEqual({ ok: false, reason: "state-mismatch" });
  });
  it("surfaces a provider error", () => {
    expect(parseCallback("?error=access_denied&state=S1", "S1")).toEqual({ ok: false, reason: "provider-error" });
  });
  it("ignores a URL with no auth params", () => {
    expect(parseCallback("", "S1")).toEqual({ ok: false, reason: "none" });
  });
});

describe("token request + expiry", () => {
  it("sends the verifier, never a client secret", () => {
    const b = tokenRequestBody(cfg, "CODE", "VERIFIER").toString();
    expect(b).toContain("grant_type=authorization_code");
    expect(b).toContain("code_verifier=VERIFIER");
    expect(b).not.toContain("client_secret");
  });
  it("treats a token within 30s of expiry as expired", () => {
    const now = 1_000_000;
    expect(isExpired(now + 60_000, now)).toBe(false);
    expect(isExpired(now + 10_000, now)).toBe(true);
    expect(isExpired(now - 1, now)).toBe(true);
  });
});
