/**
 * Shared mutable log state.
 *
 * Lives here (not in debug.ts) so that `logger.ts` can consult whether TUI
 * logging is enabled without importing `debug.ts`, breaking the module cycle
 * `logger -> debug -> storage -> logger`.
 */

let debugTuiEnabled = false;

/**
 * Set whether TUI log panel logging is enabled.
 */
export function setDebugTuiEnabled(enabled: boolean): void {
  debugTuiEnabled = enabled;
}

/**
 * Check whether TUI log panel logging is enabled.
 */
export function isDebugTuiEnabled(): boolean {
  return debugTuiEnabled;
}
