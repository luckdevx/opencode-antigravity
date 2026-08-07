import { beforeAll, describe, expect, it } from "vitest";
import { getHiddenModels, initRuntimeConfig } from "./loader";
import { getAllowedUpstreamBases, getEffectiveModelDefinitions, getModelBaseName } from "./models";
import type { AntigravityConfig } from "./schema";
import { DEFAULT_CONFIG } from "./schema";

// Inject a mock config with hidden_models set (self-contained, no disk read).
const HIDDEN = [
  "antigravity-gemini-3-pro",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
];

beforeAll(() => {
  const cfg: AntigravityConfig = { ...DEFAULT_CONFIG, hidden_models: HIDDEN };
  initRuntimeConfig(cfg);
});

describe("getModelBaseName", () => {
  it("strips antigravity prefix, preview suffixes, and tier suffixes", () => {
    expect(getModelBaseName("antigravity-gemini-3-pro")).toBe("gemini-3-pro");
    expect(getModelBaseName("gemini-3-pro-preview")).toBe("gemini-3-pro");
    expect(getModelBaseName("gemini-3.1-pro-preview-customtools")).toBe("gemini-3.1-pro");
    expect(getModelBaseName("gemini-3.1-pro-high")).toBe("gemini-3.1-pro");
    expect(getModelBaseName("antigravity-gemini-3-flash")).toBe("gemini-3-flash");
    expect(getModelBaseName("antigravity-claude-opus-4-6-thinking")).toBe("claude-opus-4-6-thinking");
    expect(getModelBaseName("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    // GPT-OSS: "medium" is part of the model name, NOT a thinking tier
    expect(getModelBaseName("antigravity-gpt-oss-120b-medium")).toBe("gpt-oss-120b-medium");
  });
});

describe("hidden_models config", () => {
  it("reads hidden_models from antigravity.json", () => {
    const hidden = getHiddenModels();
    expect(hidden).toContain("antigravity-gemini-3-pro");
    expect(hidden).toContain("gemini-3-pro-preview");
    expect(hidden.length).toBeGreaterThanOrEqual(2);
  });
});

describe("getEffectiveModelDefinitions", () => {
  it("excludes hidden models but keeps usable ones", () => {
    const eff = getEffectiveModelDefinitions();
    const keys = Object.keys(eff);
    // hidden ones gone
    expect(keys).not.toContain("antigravity-gemini-3-pro");
    expect(keys).not.toContain("gemini-3-pro-preview");
    expect(keys).not.toContain("gemini-2.5-flash");
    expect(keys).not.toContain("gemini-2.5-pro");
    // working ones kept
    expect(keys).toContain("antigravity-gemini-3.1-pro");
    expect(keys).toContain("antigravity-gemini-3-flash");
    expect(keys).toContain("antigravity-gemini-3.5-flash");
    expect(keys).toContain("antigravity-gpt-oss-120b-medium");
    expect(keys).toContain("antigravity-claude-sonnet-4-6");
    expect(keys).toContain("antigravity-claude-opus-4-6-thinking");
  });
});

describe("getAllowedUpstreamBases", () => {
  it("returns bases for non-hidden models only", () => {
    const bases = getAllowedUpstreamBases();
    expect(bases).not.toBeNull();
    // dead/hidden model bases excluded
    expect(bases!.has("gemini-3-pro")).toBe(false);
    expect(bases!.has("gemini-2.5-flash")).toBe(false);
    expect(bases!.has("gemini-2.5-pro")).toBe(false);
    // working model bases included
    expect(bases!.has("gemini-3.1-pro")).toBe(true);
    expect(bases!.has("gemini-3-flash")).toBe(true);
    expect(bases!.has("gemini-3.5-flash")).toBe(true);
    expect(bases!.has("gpt-oss-120b-medium")).toBe(true);
    expect(bases!.has("claude-sonnet-4-6")).toBe(true);
    expect(bases!.has("claude-opus-4-6-thinking")).toBe(true);
  });
});

describe("quota filtering with real probe data", () => {
  // Real upstream models returned by fetchAvailableModels for a live account
  const probeModels: Record<string, { displayName?: string; quotaInfo?: { remainingFraction: number } }> = {
    "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6 (Thinking)", quotaInfo: { remainingFraction: 1 } },
    "gemini-pro-agent": { displayName: "Gemini 3.1 Pro (High)", quotaInfo: { remainingFraction: 1 } },
    "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro (High)", quotaInfo: { remainingFraction: 1 } },
    "gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro (Low)", quotaInfo: { remainingFraction: 1 } },
    "claude-opus-4-6-thinking": {
      displayName: "Claude Opus 4.6 (Thinking)",
      quotaInfo: { remainingFraction: 1 },
    },
    "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: { remainingFraction: 1 } },
    "gemini-3.1-flash-lite": { displayName: "Gemini 3.1 Flash Lite", quotaInfo: { remainingFraction: 1 } },
    "gemini-3.5-flash-low": { displayName: "Gemini 3.5 Flash (Medium)", quotaInfo: { remainingFraction: 1 } },
    "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 1 } },
    "gemini-2.5-flash": { displayName: "Gemini 3.1 Flash Lite", quotaInfo: { remainingFraction: 1 } },
    "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", quotaInfo: { remainingFraction: 1 } },
  };

  it("Antigravity quota: keeps models whose base matches a non-hidden model", () => {
    const bases = getAllowedUpstreamBases()!;
    const kept: string[] = [];
    for (const [name, entry] of Object.entries(probeModels)) {
      // classifyQuotaGroup: gemini/claude are the two Antigravity quota buckets
      const lower = `${name} ${entry.displayName ?? ""}`.toLowerCase();
      const isClaude = lower.includes("claude") || lower.includes("gpt");
      const isGemini = lower.includes("gemini-2") || lower.includes("gemini-3") || lower.includes("gemini 3");
      if (!isClaude && !isGemini) continue;
      if (bases.has(getModelBaseName(name))) kept.push(name);
    }
    // Claude + Gemini 3 Pro/Flash survive
    expect(kept).toContain("claude-sonnet-4-6");
    expect(kept).toContain("claude-opus-4-6-thinking");
    expect(kept).toContain("gemini-3.1-pro-high");
    expect(kept).toContain("gemini-3.1-pro-low");
    expect(kept).toContain("gemini-3-flash");
    // GPT-OSS is classified under the claude bucket and is not hidden
    expect(kept).toContain("gpt-oss-120b-medium");
    // gemini-2.5-pro is hidden, so filtered out
    expect(kept).not.toContain("gemini-2.5-pro");
    // unrelated flash-lite / pro-agent filtered out (base mismatch)
    expect(kept).not.toContain("gemini-3.1-flash-lite");
    expect(kept).not.toContain("gemini-pro-agent");
  });
});
