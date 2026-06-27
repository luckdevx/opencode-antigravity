/**
 * Configuration module for opencode-antigravity-auth plugin.
 *
 * @example
 * ```typescript
 * import { loadConfig, type AntigravityConfig } from "./config";
 *
 * const config = loadConfig(directory);
 * if (config.session_recovery) {
 *   // Enable session recovery
 * }
 * ```
 */

export {
  configExists,
  getKeepThinking,
  initRuntimeConfig,
  loadConfig,
} from "./loader";
export {
  getConfigDir,
  getDefaultLogsDir,
  getProjectConfigPath,
  getUserConfigPath,
} from "./paths";
export {
  type AntigravityConfig,
  AntigravityConfigSchema,
  DEFAULT_CONFIG,
  type SignatureCacheConfig,
  SignatureCacheConfigSchema,
} from "./schema";
