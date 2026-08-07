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
 * Load and parse a config file, returning null if not found or invalid.
 */
function loadConfigFile(path: string): Partial<AntigravityConfig> | null {
  try {
    if (!existsSync(path)) {
      return null;
    }

    const content = readFileSync(path, "utf-8");
    const rawConfig = JSON.parse(content);

    // Validate with Zod (partial - we'll merge with defaults later)
    const result = AntigravityConfigSchema.partial().safeParse(rawConfig);

    if (!result.success) {
      log.warn("Config validation error", {
        path,
        issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      });
      return null;
    }

    return result.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      log.warn("Invalid JSON in config file", { path, error: error.message });
    } else {
      log.warn("Failed to load config file", { path, error: String(error) });
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
 * Load the complete configuration.
 *
 * @param directory - The project directory (for project-level config)
 * @returns Fully resolved configuration
 */
export function loadConfig(directory: string): AntigravityConfig {
  // Start with defaults
  let config: AntigravityConfig = { ...DEFAULT_CONFIG };

  // Load user config file (if exists)
  const userConfigPath = getUserConfigPath();
  const userConfig = loadConfigFile(userConfigPath);
  if (userConfig) {
    config = mergeConfigs(config, userConfig);
  }

  // Load project config file (if exists) - overrides user config
  const projectConfigPath = getProjectConfigPath(directory);
  const projectConfig = loadConfigFile(projectConfigPath);
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig);
  }

  return config;
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
