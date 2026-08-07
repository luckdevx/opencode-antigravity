/**
 * Centralized filesystem path resolution for opencode-antigravity.
 *
 * All modules that need to locate files in the OpenCode config directory must
 * use this module instead of re-implementing `getConfigDir` locally.
 *
 * Config directory precedence:
 * 1. OPENCODE_CONFIG_DIR env var (if set)
 * 2. ~/.config/opencode on all platforms (including Windows)
 *
 * A legacy `%APPDATA%\opencode` path exists only for Windows migration and is
 * never the active location when OPENCODE_CONFIG_DIR is set.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Get the config directory path, with the following precedence:
 * 1. OPENCODE_CONFIG_DIR env var (if set)
 * 2. ~/.config/opencode (all platforms, including Windows)
 */
export function getConfigDir(): string {
  // 1. Check for explicit override via env var
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }

  // 2. Use ~/.config/opencode on all platforms (including Windows)
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Get the legacy Windows config directory (%APPDATA%\opencode).
 * Used for migration from older plugin versions.
 */
export function getLegacyWindowsConfigDir(): string {
  return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
}

/**
 * Get the user-level config file path.
 */
export function getUserConfigPath(): string {
  return join(getConfigDir(), "antigravity.json");
}

/**
 * Get the project-level config file path.
 */
export function getProjectConfigPath(directory: string): string {
  return join(directory, ".opencode", "antigravity.json");
}

/**
 * Get the default logs directory.
 */
export function getDefaultLogsDir(): string {
  return join(getConfigDir(), "antigravity-logs");
}

/**
 * Get the accounts storage file path.
 */
export function getAccountsFilePath(): string {
  return join(getConfigDir(), "antigravity-accounts.json");
}

/**
 * Get the legacy accounts storage file path (Windows only).
 */
export function getLegacyAccountsFilePath(): string {
  return join(getLegacyWindowsConfigDir(), "antigravity-accounts.json");
}

/**
 * Get the signature cache file path.
 */
export function getSignatureCacheFilePath(): string {
  return join(getConfigDir(), "antigravity-signature-cache.json");
}
