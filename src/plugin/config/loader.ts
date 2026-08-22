/**
 * Configuration loader for opencode-antigravity plugin.
 *
 * Loads config from files.
 * Priority (lowest to highest):
 * 1. Schema defaults
 * 2. User config file
 * 3. Project config file
 */

import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "../logger";
import { getProjectConfigPath, getUserConfigPath } from "./paths";
import { type AntigravityConfig, AntigravityConfigSchema, DEFAULT_CONFIG } from "./schema";

const log = createLogger("config");

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Result of loading the configuration, including human-readable problems found
 * in user/project config files. `warnings` is empty when every file was valid.
 */
export interface ConfigLoadResult {
  config: AntigravityConfig;
  /**
   * One entry per problem (invalid values, invalid JSON, unknown keys).
   * The affected settings fall back to defaults; valid keys still apply.
   */
  warnings: string[];
}

/** Cap per-file issue lists so toasts stay readable. */
const MAX_ISSUES_PER_FILE = 5;

/**
 * Keys accepted by the schema - anything else in a config file is a likely
 * typo and is reported (and ignored) instead of being silently stripped.
 */
function getSchemaKeys(): Set<string> {
  return new Set(Object.keys(AntigravityConfigSchema.shape));
}

/**
 * Load and parse a config file, returning null if not found or invalid.
 * Appends a human-readable warning for every problem found.
 */
function loadConfigFile(path: string, warnings: string[]): Partial<AntigravityConfig> | null {
  try {
    if (!existsSync(path)) {
      return null;
    }

    const content = readFileSync(path, "utf-8");
    const rawConfig = JSON.parse(content);

    // Validate with Zod (partial - we'll merge with defaults later)
    const result = AntigravityConfigSchema.partial().safeParse(rawConfig);

    if (!result.success) {
      const issueText = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .slice(0, MAX_ISSUES_PER_FILE)
        .join("; ");
      log.warn("Config validation error", { path, issues: issueText });
      warnings.push(`Invalid value(s) in ${path}: ${issueText}`);
      return null;
    }

    // Valid values, but flag unknown keys (likely typos) instead of dropping
    // them silently. Known keys keep applying.
    if (rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)) {
      const knownKeys = getSchemaKeys();
      const unknownKeys = Object.keys(rawConfig).filter((key) => !knownKeys.has(key));
      if (unknownKeys.length > 0) {
        log.warn("Unknown config keys ignored", { path, keys: unknownKeys });
        warnings.push(`Unknown key(s) in ${path} (ignored): ${unknownKeys.join(", ")}`);
      }
    }

    return result.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      const message = `Invalid JSON in ${path}: ${error.message}`;
      log.warn("Invalid JSON in config file", { path, error: error.message });
      warnings.push(message);
    } else {
      const message = `Could not read config file ${path}: ${String(error)}`;
      log.warn("Failed to load config file", { path, error: String(error) });
      warnings.push(message);
    }
    return null;
  }
}

/**
 * Deep merge two config objects, with override taking precedence.
 */
function mergeConfigs(base: AntigravityConfig, override: Partial<AntigravityConfig>): AntigravityConfig {
  return {
    ...base,
    ...override,
    // Deep merge signature_cache if both exist
    signature_cache: override.signature_cache
      ? {
          ...base.signature_cache,
          ...override.signature_cache,
        }
      : base.signature_cache,
  };
}

// =============================================================================
// Main Loader
// =============================================================================

/**
 * Load the complete configuration together with any problems found in the
 * config files. Use this when you can surface warnings to the user (toast,
 * console); `loadConfig()` is the shorthand that discards them.
 *
 * @param directory - The project directory (for project-level config)
 */
export function loadConfigWithWarnings(directory: string): ConfigLoadResult {
  const warnings: string[] = [];

  // Start with defaults
  let config: AntigravityConfig = { ...DEFAULT_CONFIG };

  // Load user config file (if exists)
  const userConfigPath = getUserConfigPath();
  const userConfig = loadConfigFile(userConfigPath, warnings);
  if (userConfig) {
    config = mergeConfigs(config, userConfig);
  }

  // Load project config file (if exists) - overrides user config
  const projectConfigPath = getProjectConfigPath(directory);
  const projectConfig = loadConfigFile(projectConfigPath, warnings);
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig);
  }

  return { config, warnings };
}

/**
 * Load the complete configuration.
 *
 * @param directory - The project directory (for project-level config)
 * @returns Fully resolved configuration
 */
export function loadConfig(directory: string): AntigravityConfig {
  return loadConfigWithWarnings(directory).config;
}

/**
 * Check if a config file exists at the given path.
 */
export function configExists(path: string): boolean {
  return existsSync(path);
}

let runtimeConfig: AntigravityConfig | null = null;

export function initRuntimeConfig(config: AntigravityConfig): void {
  runtimeConfig = config;
}

export function getKeepThinking(): boolean {
  return runtimeConfig?.keep_thinking ?? false;
}

/**
 * Returns the list of model keys hidden via `hidden_models` in antigravity.json.
 * Empty array when unconfigured (no filtering, backward compatible).
 */
export function getHiddenModels(): string[] {
  return runtimeConfig?.hidden_models ?? [];
}
