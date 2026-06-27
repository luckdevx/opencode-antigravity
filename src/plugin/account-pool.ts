/**
 * Account pool persistence helpers.
 *
 * Extracted from the main plugin entrypoint: merges freshly authenticated
 * accounts into storage and builds success results from stored accounts.
 */

import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts } from "./storage";

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export async function persistAccountPool(
  results: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>>,
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) {
    return;
  }

  const now = Date.now();

  // If replaceAll is true (fresh login), start with empty accounts
  // Otherwise, load existing accounts and merge
  const stored = replaceAll ? null : await loadAccounts();
  const accounts = stored?.accounts ? [...stored.accounts] : [];

  const indexByRefreshToken = new Map<string, number>();
  const indexByEmail = new Map<string, number>();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (acc?.refreshToken) {
      indexByRefreshToken.set(acc.refreshToken, i);
    }
    if (acc?.email) {
      indexByEmail.set(acc.email, i);
    }
  }

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh);
    if (!parts.refreshToken) {
      continue;
    }

    // First, check for existing account by email (prevents duplicates when refresh token changes)
    // Only use email-based deduplication if the new account has an email
    const existingByEmail = result.email ? indexByEmail.get(result.email) : undefined;
    const existingByToken = indexByRefreshToken.get(parts.refreshToken);

    // Prefer email-based match to handle refresh token rotation
    const existingIndex = existingByEmail ?? existingByToken;

    if (existingIndex === undefined) {
      // New account - add it
      const newIndex = accounts.length;
      indexByRefreshToken.set(parts.refreshToken, newIndex);
      if (result.email) {
        indexByEmail.set(result.email, newIndex);
      }
      accounts.push({
        email: result.email,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        addedAt: now,
        lastUsed: now,
        enabled: true,
      });
      continue;
    }

    const existing = accounts[existingIndex];
    if (!existing) {
      continue;
    }

    // Update existing account (this handles both email match and token match cases)
    // When email matches but token differs, this effectively replaces the old token
    const oldToken = existing.refreshToken;
    accounts[existingIndex] = {
      ...existing,
      email: result.email ?? existing.email,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId ?? existing.projectId,
      managedProjectId: parts.managedProjectId ?? existing.managedProjectId,
      lastUsed: now,
    };

    // Update the token index if the token changed
    if (oldToken !== parts.refreshToken) {
      indexByRefreshToken.delete(oldToken);
      indexByRefreshToken.set(parts.refreshToken, existingIndex);
    }
  }

  if (accounts.length === 0) {
    return;
  }

  // For fresh logins, always start at index 0
  const activeIndex = replaceAll
    ? 0
    : typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex)
      ? stored.activeIndex
      : 0;

  await saveAccounts({
    version: 4,
    accounts,
    activeIndex: clampInt(activeIndex, 0, accounts.length - 1),
    activeIndexByFamily: {
      claude: clampInt(activeIndex, 0, accounts.length - 1),
      gemini: clampInt(activeIndex, 0, accounts.length - 1),
    },
  });
}

export function buildAuthSuccessFromStoredAccount(account: {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  email?: string;
}): Extract<AntigravityTokenExchangeResult, { type: "success" }> {
  const refresh = formatRefreshParts({
    refreshToken: account.refreshToken,
    projectId: account.projectId,
    managedProjectId: account.managedProjectId,
  });

  return {
    type: "success",
    refresh,
    access: "",
    expires: 0,
    email: account.email,
    projectId: account.projectId ?? "",
  };
}
