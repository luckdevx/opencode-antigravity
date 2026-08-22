import { describe, expect, it } from "vitest";

import { getModelBaseName, OPENCODE_MODEL_DEFINITIONS } from "./models";

const getModel = (name: string) => {
  const model = OPENCODE_MODEL_DEFINITIONS[name];
  if (!model) {
    throw new Error(`Missing model definition for ${name}`);
  }
  return model;
};

describe("OPENCODE_MODEL_DEFINITIONS", () => {
  it("includes the full set of configured models", () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort();

    expect(modelNames).toEqual([
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-claude-sonnet-4-6",
      "antigravity-gemini-3-flash",
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-3.5-flash",
      "antigravity-gemini-3.6-flash",
      "antigravity-gemini-3.7-flash",
      "antigravity-gpt-oss-120b-medium",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ]);
  });

  it("defines Gemini 3 variants for Antigravity models", () => {
    expect(getModel("antigravity-gemini-3-pro").variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });

    expect(getModel("antigravity-gemini-3.1-pro").variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });

    expect(getModel("antigravity-gemini-3-flash").variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });

    // Gemini 3.7 Flash: all variants share the single tiered upstream ID,
    // the thinking level is passed via generationConfig.
    expect(getModel("antigravity-gemini-3.7-flash").variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
  });

  it("defines thinking budget variants for Claude thinking models", () => {
    expect(getModel("antigravity-claude-opus-4-6-thinking").variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    });
  });
});

describe("getModelBaseName", () => {
  it("strips prefixes and thinking tiers to find canonical base name", () => {
    expect(getModelBaseName("antigravity-gemini-3-pro")).toBe("gemini-3-pro");
    expect(getModelBaseName("gemini-3-pro-preview")).toBe("gemini-3-pro");
    expect(getModelBaseName("gemini-3.1-pro-preview-customtools")).toBe("gemini-3.1-pro");
    expect(getModelBaseName("gemini-3.1-pro-high")).toBe("gemini-3.1-pro");
    expect(getModelBaseName("antigravity-claude-opus-4-6-thinking")).toBe("claude-opus-4-6-thinking");
    expect(getModelBaseName("antigravity-gpt-oss-120b-medium")).toBe("gpt-oss-120b-medium");
  });

  it("strips -tiered from Gemini 3.7 Flash upstream IDs (BLOCKER fix)", () => {
    // Ensures aggregateQuota maps upstream "gemini-3.7-flash-tiered" to "gemini-3.7-flash",
    // matching allowedBases when hidden_models is configured.
    expect(getModelBaseName("gemini-3.7-flash-tiered")).toBe("gemini-3.7-flash");
    expect(getModelBaseName("antigravity-gemini-3.7-flash")).toBe("gemini-3.7-flash");
    expect(getModelBaseName("gemini-3.7-flash-tiered-preview")).toBe("gemini-3.7-flash");
  });
});
