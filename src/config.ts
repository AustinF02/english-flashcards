import type { AuthConfig } from "./auth";

/**
 * Runtime configuration. `config.json` is generated from CloudFormation outputs at
 * deploy time and contains no secrets (ids and public URLs only). When it is absent
 * (local development) the app runs in clearly-labelled device-only mode and shows
 * no sign-in at all — we never simulate cloud sign-in or sync.
 */
export interface RuntimeConfig {
  auth: AuthConfig;
  apiBase: string;   // "/api" (same-origin through CloudFront)
}

export function parseConfig(raw: unknown): RuntimeConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const a = r["auth"] as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return null;
  const { domain, clientId, redirectUri, scope } = a as Record<string, unknown>;
  const apiBase = r["apiBase"];
  const okStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!okStr(domain) || !okStr(clientId) || !okStr(redirectUri) || !okStr(scope) || !okStr(apiBase)) return null;
  if (!domain.startsWith("https://")) return null;
  return { auth: { domain, clientId, redirectUri, scope }, apiBase };
}

export async function loadConfig(fetchFn: typeof fetch = fetch): Promise<RuntimeConfig | null> {
  try {
    const r = await fetchFn("/config.json", { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return parseConfig(await r.json());
  } catch {
    return null;
  }
}
