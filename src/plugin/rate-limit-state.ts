/**
 * In-memory rate limit / retry state and helpers.
 *
 * Extracted from the main plugin entrypoint. Tracks per-account backoff,
 * consecutive failure cooldowns and empty-response retry attempts across
 * requests, since these need to persist beyond a single request.
 */

import type { HeaderStyle } from "../constants";
import type { ModelFamily } from "./storage";

export const FIRST_RETRY_DELAY_MS = 1000; // 1s - first 429 quick retry on same account
export const SWITCH_ACCOUNT_DELAY_MS = 5000; // 5s - delay before switching to another account

const RATE_LIMIT_DEDUP_WINDOW_MS = 2000; // 2 seconds - concurrent requests within this window are deduplicated
const RATE_LIMIT_STATE_RESET_MS = 120_000; // Reset consecutive counter after 2 minutes of no 429s

interface RateLimitBackoffState {
  consecutive429: number;
  lastAt: number;
  quotaKey: string; // Track which quota this state is for
}

// Key format: `${accountIndex}:${quotaKey}` for per-account-per-quota tracking
const rateLimitStateByAccountQuota = new Map<string, RateLimitBackoffState>();

// Track empty response retry attempts (ported from LLM-API-Key-Proxy)
const emptyResponseAttempts = new Map<string, number>();

// Track consecutive non-429 failures per account to prevent infinite loops
const accountFailureState = new Map<number, { consecutiveFailures: number; lastFailureAt: number }>();
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 30_000; // 30 seconds cooldown after max failures
const FAILURE_STATE_RESET_MS = 120_000; // Reset failure count after 2 minutes of no failures

export function headerStyleToQuotaKey(headerStyle: HeaderStyle, family: ModelFamily): string {
  if (family === "claude") return "claude";
  return headerStyle === "antigravity" ? "gemini-antigravity" : "gemini-cli";
}

/**
 * Get rate limit backoff with time-window deduplication.
 *
 * @param accountIndex - The account index
 * @param quotaKey - The quota key (e.g., "gemini-cli", "gemini-antigravity", "claude")
 * @param serverRetryAfterMs - Server-provided retry delay (if any)
 * @param maxBackoffMs - Maximum backoff delay in milliseconds (default 60000)
 * @returns { attempt, delayMs, isDuplicate } - isDuplicate=true if within dedup window
 */
export function getRateLimitBackoff(
  accountIndex: number,
  quotaKey: string,
  serverRetryAfterMs: number | null,
  maxBackoffMs: number = 60_000,
): { attempt: number; delayMs: number; isDuplicate: boolean } {
  const now = Date.now();
  const stateKey = `${accountIndex}:${quotaKey}`;
  const previous = rateLimitStateByAccountQuota.get(stateKey);

  // Check if this is a duplicate 429 within the dedup window
  if (previous && now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS) {
    // Same rate limit event from concurrent request - don't increment
    const baseDelay = serverRetryAfterMs ?? 1000;
    const backoffDelay = Math.min(baseDelay * 2 ** (previous.consecutive429 - 1), maxBackoffMs);
    return {
      attempt: previous.consecutive429,
      delayMs: Math.max(baseDelay, backoffDelay),
      isDuplicate: true,
    };
  }

  // Check if we should reset (no 429 for 2 minutes) or increment
  const attempt =
    previous && now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS ? previous.consecutive429 + 1 : 1;

  rateLimitStateByAccountQuota.set(stateKey, {
    consecutive429: attempt,
    lastAt: now,
    quotaKey,
  });

  const baseDelay = serverRetryAfterMs ?? 1000;
  const backoffDelay = Math.min(baseDelay * 2 ** (attempt - 1), maxBackoffMs);
  return { attempt, delayMs: Math.max(baseDelay, backoffDelay), isDuplicate: false };
}

/**
 * Reset rate limit state for an account+quota combination.
 * Only resets the specific quota, not all quotas for the account.
 */
export function resetRateLimitState(accountIndex: number, quotaKey: string): void {
  const stateKey = `${accountIndex}:${quotaKey}`;
  rateLimitStateByAccountQuota.delete(stateKey);
}

export function trackAccountFailure(accountIndex: number): {
  failures: number;
  shouldCooldown: boolean;
  cooldownMs: number;
} {
  const now = Date.now();
  const previous = accountFailureState.get(accountIndex);

  // Reset if last failure was more than 2 minutes ago
  const failures =
    previous && now - previous.lastFailureAt < FAILURE_STATE_RESET_MS ? previous.consecutiveFailures + 1 : 1;

  accountFailureState.set(accountIndex, { consecutiveFailures: failures, lastFailureAt: now });

  const shouldCooldown = failures >= MAX_CONSECUTIVE_FAILURES;
  const cooldownMs = shouldCooldown ? FAILURE_COOLDOWN_MS : 0;

  return { failures, shouldCooldown, cooldownMs };
}

export function resetAccountFailureState(accountIndex: number): void {
  accountFailureState.delete(accountIndex);
}

export function getEmptyResponseAttempts(key: string): number {
  return emptyResponseAttempts.get(key) ?? 0;
}

export function incrementEmptyResponseAttempts(key: string): number {
  const current = getEmptyResponseAttempts(key) + 1;
  emptyResponseAttempts.set(key, current);
  return current;
}

export function clearEmptyResponseAttempts(key: string): void {
  emptyResponseAttempts.delete(key);
}

/**
 * Sleep for a given number of milliseconds, respecting an abort signal.
 */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
