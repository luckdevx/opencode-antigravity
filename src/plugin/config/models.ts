import type { ProviderModel } from "../types";
import { getHiddenModels } from "./loader";

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface ModelThinkingConfig {
  thinkingBudget: number;
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel;
  thinkingConfig?: ModelThinkingConfig;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export type ModelModality = "text" | "image" | "pdf";

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface OpencodeModelDefinition extends ProviderModel {
  name: string;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;

const DEFAULT_MODALITIES: ModelModalities = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  "antigravity-gemini-3-pro": {
    name: "Gemini 3 Pro (Antigravity)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-gemini-3.1-pro": {
    name: "Gemini 3.1 Pro (Antigravity)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-gemini-3-flash": {
    name: "Gemini 3 Flash (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-gemini-3.5-flash": {
    name: "Gemini 3.5 Flash (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6 (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-claude-opus-4-6-thinking": {
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  },
  "antigravity-gpt-oss-120b-medium": {
    name: "GPT-OSS 120B Medium (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-2.5-flash": {
    name: "Gemini 2.5 Flash (Gemini CLI)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro (Gemini CLI)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3-flash-preview": {
    name: "Gemini 3 Flash Preview (Gemini CLI)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3-pro-preview": {
    name: "Gemini 3 Pro Preview (Gemini CLI)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.1-pro-preview": {
    name: "Gemini 3.1 Pro Preview (Gemini CLI)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.1-pro-preview-customtools": {
    name: "Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
};

// =============================================================================
// Model Visibility (hidden_models)
// =============================================================================

const ANTIGRAVITY_PREFIX_REGEX = /^antigravity-/i;
const PREVIEW_CUSTOMTOOLS_SUFFIX_REGEX = /-preview-customtools$/i;
const PREVIEW_SUFFIX_REGEX = /-preview$/i;
const TIER_SUFFIX_REGEX = /-(minimal|low|medium|high)$/i;

/**
 * Whether a model supports thinking tier suffixes (-low/-medium/-high/-minimal).
 * Only Gemini 3, Gemini 2.5, and Claude thinking models use tier suffixes.
 * GPT-OSS models like "gpt-oss-120b-medium" have "medium" as part of the name.
 */
function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5") ||
    (lower.includes("claude") && lower.includes("thinking"))
  );
}

/**
 * Derive the canonical base model name from a config key or an upstream API
 * model name. Strips: `antigravity-` prefix, `-preview-customtools`,
 * `-preview`, and thinking-tier suffixes (`-low`/`-medium`/`-high`/`-minimal`)
 * — but only for models that actually use thinking tiers.
 *
 * Examples:
 *   "antigravity-gemini-3-pro"            -> "gemini-3-pro"
 *   "gemini-3-pro-preview"                -> "gemini-3-pro"
 *   "gemini-3.1-pro-preview-customtools"  -> "gemini-3.1-pro"
 *   "gemini-3.1-pro-high" (upstream)      -> "gemini-3.1-pro"
 *   "antigravity-claude-opus-4-6-thinking" -> "claude-opus-4-6-thinking"
 *   "antigravity-gpt-oss-120b-medium"     -> "gpt-oss-120b-medium" (medium is part of name)
 */
export function getModelBaseName(model: string): string {
  const stripped = model
    .replace(ANTIGRAVITY_PREFIX_REGEX, "")
    .replace(PREVIEW_CUSTOMTOOLS_SUFFIX_REGEX, "")
    .replace(PREVIEW_SUFFIX_REGEX, "");
  if (supportsThinkingTiers(stripped)) {
    return stripped.replace(TIER_SUFFIX_REGEX, "");
  }
  return stripped;
}

/**
 * The full model manifest with `hidden_models` entries removed.
 * Used by the "Configure models" flow so the opencode.json model picker only
 * contains models the user can actually use.
 */
export function getEffectiveModelDefinitions(): OpencodeModelDefinitions {
  const hidden = getHiddenModels();
  if (hidden.length === 0) {
    return { ...OPENCODE_MODEL_DEFINITIONS };
  }
  const hiddenSet = new Set(hidden);
  const result: OpencodeModelDefinitions = {};
  for (const [key, def] of Object.entries(OPENCODE_MODEL_DEFINITIONS)) {
    if (!hiddenSet.has(key)) {
      result[key] = def;
    }
  }
  return result;
}

/**
 * Set of canonical base names derived from the effective (non-hidden) model
 * definitions. The quota display uses this to show quota only for models the
 * user keeps — keeping the model list and the quota view consistent.
 *
 * Returns `null` when `hidden_models` is empty, signaling "no filtering"
 * (backward compatible: show every upstream model as before).
 */
export function getAllowedUpstreamBases(): Set<string> | null {
  const hidden = getHiddenModels();
  if (hidden.length === 0) {
    return null;
  }
  const effective = getEffectiveModelDefinitions();
  const bases = new Set<string>();
  for (const key of Object.keys(effective)) {
    bases.add(getModelBaseName(key));
  }
  return bases;
}
