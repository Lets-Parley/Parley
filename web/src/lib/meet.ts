import { api } from "./api";

/** The slice of Google's Meet add-on SDK Parley calls. */
export type MeetSidePanel = {
  startActivity(opts: { mainStageUrl: string; additionalData?: string }): Promise<void>;
};
export type MeetMainStage = {
  getActivityStartingState(): Promise<{ additionalData?: string }>;
};
type MeetSDK = {
  addon: {
    createAddonSession(opts: { cloudProjectNumber: string }): Promise<{
      createSidePanelClient(): Promise<MeetSidePanel>;
      createMainStageClient(): Promise<MeetMainStage>;
    }>;
  };
};

type Provider = { name: string; sdkScript: string; cloudProjectNumber: string };

/** Where the main stage document lives; the side panel hands it to Meet. */
export const MAIN_STAGE_PATH = "/embed/meet/mainstage";

/**
 * Loads the SDK from the URL the server's Meet row names and connects this
 * frame. Meet shows its own loading screen until this resolves, so it runs on
 * load, before anything else. With Meet not enabled on the server, no script
 * is ever added and this resolves null.
 */
export async function connectMeet(surface: "sidepanel"): Promise<MeetSidePanel | null>;
export async function connectMeet(surface: "mainstage"): Promise<MeetMainStage | null>;
export async function connectMeet(surface: "sidepanel" | "mainstage") {
  const cfg = await api<{ embedProviders?: Provider[] }>("GET", "/api/auth");
  const meet = cfg.embedProviders?.find((p) => p.name === "meet");
  if (!meet) return null;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = meet.sdkScript;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load the Meet add-on SDK"));
    document.head.append(s);
  });
  const sdk = (window as unknown as { meet: MeetSDK }).meet;
  const session = await sdk.addon.createAddonSession({ cloudProjectNumber: meet.cloudProjectNumber });
  return surface === "sidepanel" ? session.createSidePanelClient() : session.createMainStageClient();
}

/**
 * The embedded token lives in sessionStorage: the side panel and main stage
 * frames share it, and it goes when the meeting tab does. Never localStorage.
 */
const TOKEN_KEY = "parley.embed.token";
export function storedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
export function storeToken(token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage refused: the token still lives for this page.
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** An RFC 7636 verifier and its S256 challenge. */
export async function newVerifier(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
