import { ANTIGRAVITY_ENDPOINT_PROD, ANTIGRAVITY_PROVIDER_ID, getAntigravityHeaders } from "../constants";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import { getAllowedUpstreamBases, getModelBaseName } from "./config/models";
import { logQuotaFetch, logQuotaStatus } from "./debug";
import { ensureProjectContext } from "./project";
import type { AccountMetadataV3 } from "./storage";
import { refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

const FETCH_TIMEOUT_MS = 10000;

export type QuotaGroup = "gemini" | "claude";

export interface QuotaGroupSummary {
  remainingFraction?: number;
  resetTime?: string;
  modelCount: number;
}

export interface QuotaModelEntry {
  modelId: string;
  displayName?: string;
  remainingFraction?: number;
  resetTime?: string;
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  models: QuotaModelEntry[];
  modelCount: number;
  error?: string;
}

export type AccountQuotaStatus = "ok" | "disabled" | "error";

export interface AccountQuotaResult {
  index: number;
  email?: string;
  status: AccountQuotaStatus;
  error?: string;
  disabled?: boolean;
  quota?: QuotaSummary;
  updatedAccount?: AccountMetadataV3;
}

interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>;
}

interface FetchAvailableModelEntry {
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
  displayName?: string;
  modelName?: string;
}

function buildAuthFromAccount(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: undefined,
    expires: undefined,
  };
}

function normalizeRemainingFraction(value: unknown): number {
  // If value is missing or invalid, treat as exhausted (0%)
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null;
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}

/**
 * Classifies a model into one of the two shared Antigravity quota buckets:
 * - "claude": Claude models AND GPT-OSS (they share the same bucket upstream)
 * - "gemini": every Gemini model (Pro/Flash/Lite) — they all share one bucket
 */
export function classifyQuotaGroup(modelName: string, displayName?: string): QuotaGroup | null {
  const combined = `${modelName} ${displayName ?? ""}`.toLowerCase();
  if (combined.includes("claude") || combined.includes("gpt")) {
    return "claude";
  }
  if (combined.includes("gemini-3") || combined.includes("gemini 3") || combined.includes("gemini-2")) {
    return "gemini";
  }
  return null;
}

function aggregateQuota(models?: Record<string, FetchAvailableModelEntry>): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {};
  const modelEntries: QuotaModelEntry[] = [];
  if (!models) {
    return { groups, models: modelEntries, modelCount: 0 };
  }

  const allowedBases = getAllowedUpstreamBases();
  let totalCount = 0;
  for (const [modelName, entry] of Object.entries(models)) {
    const group = classifyQuotaGroup(modelName, entry.displayName ?? entry.modelName);
    if (!group) {
      continue;
    }
    if (allowedBases !== null && !allowedBases.has(getModelBaseName(modelName))) {
      continue;
    }
    const quotaInfo = entry.quotaInfo;
    const remainingFraction = quotaInfo ? normalizeRemainingFraction(quotaInfo.remainingFraction) : undefined;
    const resetTime = quotaInfo?.resetTime;
    const resetTimestamp = parseResetTime(resetTime);

    totalCount += 1;

    modelEntries.push({
      modelId: modelName,
      displayName: entry.displayName ?? entry.modelName,
      remainingFraction,
      resetTime,
    });

    const existing = groups[group];
    const nextCount = (existing?.modelCount ?? 0) + 1;
    const nextRemaining =
      remainingFraction === undefined
        ? existing?.remainingFraction
        : existing?.remainingFraction === undefined
          ? remainingFraction
          : Math.min(existing.remainingFraction, remainingFraction);

    let nextResetTime = existing?.resetTime;
    if (resetTimestamp !== null) {
      if (!existing?.resetTime) {
        nextResetTime = resetTime;
      } else {
        const existingTimestamp = parseResetTime(existing.resetTime);
        if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
          nextResetTime = resetTime;
        }
      }
    }

    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount,
    };
  }

  // Sort individual model entries for consistent display (by modelId)
  modelEntries.sort((a, b) => a.modelId.localeCompare(b.modelId));

  return { groups, models: modelEntries, modelCount: totalCount };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
): Promise<FetchAvailableModelsResponse> {
  const endpoint = ANTIGRAVITY_ENDPOINT_PROD;
  const quotaUserAgent = getAntigravityHeaders()["User-Agent"] || "antigravity/windows/amd64";
  const errors: string[] = [];

  const body = projectId ? { project: projectId } : {};
  const response = await fetchWithTimeout(`${endpoint}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": quotaUserAgent,
    },
    body: JSON.stringify(body),
  });

  if (response.ok) {
    return (await response.json()) as FetchAvailableModelsResponse;
  }

  const message = await response.text().catch(() => "");
  const snippet = message.trim().slice(0, 200);
  errors.push(`fetchAvailableModels ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`);

  throw new Error(errors.join("; ") || "fetchAvailableModels failed");
}

function applyAccountUpdates(
  account: AccountMetadataV3,
  auth: OAuthAuthDetails,
): AccountMetadataV3 | undefined {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  const updated: AccountMetadataV3 = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
  };

  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId;

  return changed ? updated : undefined;
}

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountQuotaResult[]> {
  const results: AccountQuotaResult[] = [];

  logQuotaFetch("start", accounts.length);

  for (const [index, account] of accounts.entries()) {
    const disabled = account.enabled === false;

    let auth = buildAuthFromAccount(account);

    try {
      if (accessTokenExpired(auth)) {
        const refreshed = await refreshAccessToken(auth, client, providerId);
        if (!refreshed) {
          throw new Error("Token refresh failed");
        }
        auth = refreshed;
      }

      const projectContext = await ensureProjectContext(auth);
      auth = projectContext.auth;
      const updatedAccount = applyAccountUpdates(account, auth);

      let quotaResult: QuotaSummary;

      // Fetch Antigravity quota
      const antigravityResponse = await fetchAvailableModels(
        auth.access ?? "",
        projectContext.effectiveProjectId,
      ).catch((): FetchAvailableModelsResponse => ({ models: undefined }));

      // Process Antigravity quota
      if (antigravityResponse.models === undefined) {
        quotaResult = {
          groups: {},
          models: [],
          modelCount: 0,
          error: "Failed to fetch Antigravity quota",
        };
      } else {
        quotaResult = aggregateQuota(antigravityResponse.models);
      }

      results.push({
        index,
        email: account.email,
        status: "ok",
        disabled,
        quota: quotaResult,
        updatedAccount,
      });

      // Log quota status for each family
      for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
        const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100;
        logQuotaStatus(account.email, index, remainingPercent, family);
      }
    } catch (error) {
      results.push({
        index,
        email: account.email,
        status: "error",
        disabled,
        error: error instanceof Error ? error.message : String(error),
      });
      logQuotaFetch(
        "error",
        undefined,
        `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  logQuotaFetch(
    "complete",
    accounts.length,
    `ok=${results.filter((r) => r.status === "ok").length} errors=${results.filter((r) => r.status === "error").length}`,
  );
  return results;
}
