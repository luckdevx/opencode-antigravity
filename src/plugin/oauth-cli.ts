/**
 * CLI helpers for manual OAuth authorization flows.
 *
 * Used when the local HTTP callback server cannot bind (e.g. remote SSH,
 * headless environments) or when the user chooses manual code paste.
 */

import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { exchangeAntigravity } from "../antigravity/oauth";
import { promptCliText } from "./ui/prompt";

export type OAuthCallbackParams = { code: string; state: string };

/**
 * Extract the `state` query param from a full Google authorization URL,
 * used as a fallback when the user pastes only the auth code instead of the URL.
 */
export function getStateFromAuthorizationUrl(authorizationUrl: string): string {
  try {
    return new URL(authorizationUrl).searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}

/**
 * Extract `code` and `state` parameters from a redirected localhost URL.
 */
export function extractOAuthCallbackParams(url: URL): OAuthCallbackParams | null {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return null;
  }
  return { code, state };
}

/**
 * Parse manual input from the user — accepts either the full redirected URL
 * (`http://localhost:8085/?code=...&state=...`) or just the bare code string
 * (in which case `fallbackState` is used).
 */
export function parseOAuthCallbackInput(
  value: string,
  fallbackState: string,
): OAuthCallbackParams | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { error: "Missing authorization code" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? fallbackState;

    if (!code) {
      return { error: "Missing code in callback URL" };
    }
    if (!state) {
      return { error: "Missing state in callback URL" };
    }

    return { code, state };
  } catch {
    if (!fallbackState) {
      return { error: "Missing state. Paste the full redirect URL instead of only the code." };
    }

    return { code: trimmed, state: fallbackState };
  }
}

/**
 * Interactive CLI prompt guiding the user to paste the callback URL/code
 * and completing the Antigravity OAuth token exchange.
 */
export async function promptManualOAuthInput(fallbackState: string): Promise<AntigravityTokenExchangeResult> {
  console.log("1. Open the URL above in your browser and complete Google sign-in.");
  console.log("2. After approving, copy the full redirected localhost URL from the address bar.");
  console.log("3. Paste it back here.\n");

  const callbackInput = await promptCliText("Paste the redirect URL (or just the code) here: ");
  const params = parseOAuthCallbackInput(callbackInput, fallbackState);
  if ("error" in params) {
    return { type: "failed", error: params.error };
  }

  return exchangeAntigravity(params.code, params.state);
}
