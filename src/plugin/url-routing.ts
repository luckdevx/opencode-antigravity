/**
 * URL parsing and header routing decision helpers.
 *
 * Extracted from the main plugin entrypoint to keep it cohesive:
 * these functions decide which quota pool (Antigravity vs Gemini CLI) a
 * request should use based on the request URL and model name.
 */

import type { HeaderStyle } from "../constants";
import type { AntigravityConfig } from "./config";
import { isDebugEnabled, logModelFamily } from "./debug";
import type { ModelFamily } from "./storage";
import { resolveModelWithTier } from "./transform/model-resolver";

export function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

export function toWarmupStreamUrl(value: RequestInfo): string {
  const urlString = toUrlString(value);
  try {
    const url = new URL(urlString);
    if (!url.pathname.includes(":streamGenerateContent")) {
      url.pathname = url.pathname.replace(":generateContent", ":streamGenerateContent");
    }
    url.searchParams.set("alt", "sse");
    return url.toString();
  } catch {
    return urlString;
  }
}

export function extractModelFromUrl(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:/?]+)(?::\w+)?/);
  return match?.[1] ?? null;
}

export function extractModelFromUrlWithSuffix(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:/?]+)/);
  return match?.[1] ?? null;
}

export function getModelFamilyFromUrl(urlString: string): ModelFamily {
  const model = extractModelFromUrl(urlString);
  let family: ModelFamily = "gemini";
  if (model?.includes("claude")) {
    family = "claude";
  }
  if (isDebugEnabled()) {
    logModelFamily(urlString, model, family);
  }
  return family;
}

export function resolveQuotaFallbackHeaderStyle(input: {
  family: ModelFamily;
  headerStyle: HeaderStyle;
  alternateStyle: HeaderStyle | null;
}): HeaderStyle | null {
  if (input.family !== "gemini") {
    return null;
  }
  if (!input.alternateStyle || input.alternateStyle === input.headerStyle) {
    return null;
  }
  return input.alternateStyle;
}

export type HeaderRoutingDecision = {
  cliFirst: boolean;
  preferredHeaderStyle: HeaderStyle;
  explicitQuota: boolean;
  allowQuotaFallback: boolean;
};

export function resolveHeaderRoutingDecision(
  urlString: string,
  family: ModelFamily,
  config: AntigravityConfig,
): HeaderRoutingDecision {
  const cliFirst = getCliFirst(config);
  const preferredHeaderStyle = getHeaderStyleFromUrl(urlString, family, cliFirst);
  const explicitQuota = isExplicitQuotaFromUrl(urlString);
  return {
    cliFirst,
    preferredHeaderStyle,
    explicitQuota,
    allowQuotaFallback: family === "gemini",
  };
}

export function getCliFirst(config: AntigravityConfig): boolean {
  return (config as AntigravityConfig & { cli_first?: boolean }).cli_first ?? false;
}

export function getHeaderStyleFromUrl(
  urlString: string,
  family: ModelFamily,
  cliFirst: boolean = false,
): HeaderStyle {
  if (family === "claude") {
    return "antigravity";
  }
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  if (!modelWithSuffix) {
    return cliFirst ? "gemini-cli" : "antigravity";
  }
  const { quotaPreference } = resolveModelWithTier(modelWithSuffix, { cli_first: cliFirst });
  return quotaPreference ?? "antigravity";
}

export function isExplicitQuotaFromUrl(urlString: string): boolean {
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  if (!modelWithSuffix) {
    return false;
  }
  const { explicitQuota } = resolveModelWithTier(modelWithSuffix);
  return explicitQuota ?? false;
}
