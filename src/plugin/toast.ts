/**
 * Centralized toast notifications.
 *
 * All plugin toast paths go through `showToast` so that quiet_mode,
 * toast_scope, child-session filtering, abort awareness and rate-limit
 * debouncing are applied consistently everywhere.
 */

import type { PluginClient } from "./types";

export type ToastVariant = "info" | "warning" | "success" | "error";

export type ToastScope = "root_only" | "all";

export interface ToastOptions {
  /** Optional title shown above the message. */
  title?: string;
  /** Suppress when quiet_mode is enabled (default: false, i.e. show). */
  quietMode?: boolean;
  /** Child-session filtering policy (default: "root_only"). */
  toastScope?: ToastScope;
  /** Whether the current session is a child (subagent/background). */
  isChildSession?: boolean;
  /** Abort signal; suppresses the toast once aborted. */
  abortSignal?: AbortSignal | null;
  /**
   * Debounce warning toasts mentioning rate limiting by a normalized message
   * key (default: true). Prevents toast spam during repeated 429 handling.
   */
  debounceRateLimit?: boolean;
}

// Module-level toast debounce to persist across requests (fixes toast spam)
const rateLimitToastCooldowns = new Map<string, number>();
const RATE_LIMIT_TOAST_COOLDOWN_MS = 5000;
const MAX_TOAST_COOLDOWN_ENTRIES = 100;

function cleanupToastCooldowns(): void {
  if (rateLimitToastCooldowns.size > MAX_TOAST_COOLDOWN_ENTRIES) {
    const now = Date.now();
    for (const [key, time] of rateLimitToastCooldowns) {
      if (now - time > RATE_LIMIT_TOAST_COOLDOWN_MS * 2) {
        rateLimitToastCooldowns.delete(key);
      }
    }
  }
}

function shouldShowRateLimitToast(message: string): boolean {
  cleanupToastCooldowns();
  const toastKey = message.replace(/\d+/g, "X");
  const lastShown = rateLimitToastCooldowns.get(toastKey) ?? 0;
  const now = Date.now();
  if (now - lastShown < RATE_LIMIT_TOAST_COOLDOWN_MS) {
    return false;
  }
  rateLimitToastCooldowns.set(toastKey, now);
  return true;
}

/**
 * Show a toast notification through the plugin client, applying common
 * filtering policy. Never throws; TUI unavailability is swallowed.
 *
 * @param client - The plugin client (may be unavailable).
 * @param message - Toast message.
 * @param variant - Toast variant.
 * @param options - Filtering/debounce options.
 */
export async function showToast(
  client: PluginClient | null | undefined,
  message: string,
  variant: ToastVariant,
  options: ToastOptions = {},
): Promise<void> {
  const {
    title,
    quietMode = false,
    toastScope = "root_only",
    isChildSession = false,
    abortSignal,
    debounceRateLimit = true,
  } = options;

  if (!client) return;

  // Respect quiet mode (recovery toasts opt out via quietMode: false)
  if (quietMode) return;
  if (abortSignal?.aborted) return;

  // Filter toasts for child sessions when toast_scope is "root_only"
  if (toastScope === "root_only" && isChildSession) {
    return;
  }

  if (variant === "warning" && message.toLowerCase().includes("rate") && debounceRateLimit) {
    if (!shouldShowRateLimitToast(message)) {
      return;
    }
  }

  try {
    await client.tui.showToast({
      body: { title, message, variant },
    });
  } catch {
    // TUI may not be available
  }
}
