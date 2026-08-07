import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, promises as fs, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { HeaderStyle } from "../constants";
import { getAccountsFilePath, getConfigDir, getLegacyAccountsFilePath } from "./config/paths";
import { ensureGitignore } from "./gitignore";
import { createLogger } from "./logger";

const log = createLogger("storage");

export type ModelFamily = "claude" | "gemini";
export type { HeaderStyle };

/**
 * Rate limit reset times for pre-v3 storage (single pool per family).
 * Only relevant for V1/V2 migration; kept for legacy schema compatibility.
 */
export interface RateLimitStateLegacy {
  claude?: number;
  gemini?: number;
}

/**
 * Rate limit reset times for V3+ storage, keyed by quota pool.
 */
export interface RateLimitState {
  claude?: number;
  "gemini-antigravity"?: number;
  "gemini-cli"?: number;
  [key: string]: number | undefined;
}

export interface AccountMetadataV1 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  isRateLimited?: boolean;
  rateLimitResetTime?: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}

export interface AccountStorageV1 {
  version: 1;
  accounts: AccountMetadataV1[];
  activeIndex: number;
}

export interface AccountMetadata {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitStateLegacy;
}

export interface AccountStorage {
  version: 2;
  accounts: AccountMetadata[];
  activeIndex: number;
}

export type CooldownReason = "auth-failure" | "network-error" | "project-error" | "validation-required";

export interface AccountMetadataV3 {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  enabled?: boolean;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  rateLimitResetTimes?: RateLimitState;
  coolingDownUntil?: number;
  cooldownReason?: CooldownReason;
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: import("./fingerprint").Fingerprint;
  fingerprintHistory?: import("./fingerprint").FingerprintVersion[];
  /** Set when Google asks the user to verify this account before requests can continue. */
  verificationRequired?: boolean;
  verificationRequiredAt?: number;
  verificationRequiredReason?: string;
  verificationUrl?: string;
  /** Cached soft quota data */
  cachedQuota?: Record<string, { remainingFraction?: number; resetTime?: string; modelCount: number }>;
  cachedQuotaUpdatedAt?: number;
}

export interface AccountStorageV3 {
  version: 3;
  accounts: AccountMetadataV3[];
  activeIndex: number;
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

export interface AccountStorageV4 {
  version: 4;
  accounts: AccountMetadataV3[];
  activeIndex: number;
  activeIndexByFamily?: {
    claude?: number;
    gemini?: number;
  };
}

type AnyAccountStorage = AccountStorageV1 | AccountStorage | AccountStorageV3 | AccountStorageV4;

/**
 * Migrates config from legacy Windows location to the new path.
 * Moves the file if legacy exists and new doesn't.
 * Returns true if migration was performed.
 */
function migrateLegacyWindowsConfig(): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const newPath = getAccountsFilePath();
  const legacyPath = getLegacyAccountsFilePath();

  // Only migrate if legacy exists and new doesn't
  if (!existsSync(legacyPath) || existsSync(newPath)) {
    return false;
  }

  try {
    // Ensure new config directory exists
    const newConfigDir = getConfigDir();

    mkdirSync(newConfigDir, { recursive: true });

    // Try rename first (atomic, but fails across filesystems)
    try {
      renameSync(legacyPath, newPath);
      log.info("Migrated Windows config via rename", { from: legacyPath, to: newPath });
    } catch {
      // Fallback: copy then delete (for cross-filesystem moves)
      copyFileSync(legacyPath, newPath);
      unlinkSync(legacyPath);
      log.info("Migrated Windows config via copy+delete", { from: legacyPath, to: newPath });
    }

    return true;
  } catch (error) {
    log.warn("Failed to migrate legacy Windows config, will use legacy path", {
      legacyPath,
      newPath,
      error: String(error),
    });
    return false;
  }
}

/**
 * Gets the storage path, migrating from legacy Windows location if needed.
 * On Windows, attempts to move legacy config to new path for alignment.
 */
function getStoragePathWithMigration(): string {
  const newPath = getAccountsFilePath();

  // On Windows, attempt to migrate legacy config to new location
  if (process.platform === "win32") {
    migrateLegacyWindowsConfig();

    // If migration failed and legacy still exists, fall back to it
    if (!existsSync(newPath)) {
      const legacyPath = getLegacyAccountsFilePath();
      if (existsSync(legacyPath)) {
        log.info("Using legacy Windows config path (migration failed)", {
          legacyPath,
          newPath,
        });
        return legacyPath;
      }
    }
  }

  return newPath;
}

export function getStoragePath(): string {
  return getStoragePathWithMigration();
}

const LOCK_OPTIONS = {
  stale: 10000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2,
  },
};

/**
 * Ensures the file has secure permissions (0600) on POSIX systems.
 * This is a best-effort operation and ignores errors on Windows/unsupported FS.
 */
async function ensureSecurePermissions(path: string): Promise<void> {
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // Ignore errors (e.g. Windows, file doesn't exist, FS doesn't support chmod)
  }
}

async function ensureFileExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ version: 4, accounts: [], activeIndex: 0 }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await ensureFileExists(path);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS);
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch (unlockError) {
        log.warn("Failed to release lock", { error: String(unlockError) });
      }
    }
  }
}

function mergeAccountStorage(existing: AccountStorageV4, incoming: AccountStorageV4): AccountStorageV4 {
  const accountMap = new Map<string, AccountMetadataV3>();

  for (const acc of existing.accounts) {
    if (acc.refreshToken) {
      accountMap.set(acc.refreshToken, acc);
    }
  }

  for (const acc of incoming.accounts) {
    if (acc.refreshToken) {
      const existingAcc = accountMap.get(acc.refreshToken);
      if (existingAcc) {
        accountMap.set(acc.refreshToken, {
          ...existingAcc,
          ...acc,
          // Preserve manually configured projectId/managedProjectId if not in incoming
          projectId: acc.projectId ?? existingAcc.projectId,
          managedProjectId: acc.managedProjectId ?? existingAcc.managedProjectId,
          rateLimitResetTimes: {
            ...existingAcc.rateLimitResetTimes,
            ...acc.rateLimitResetTimes,
          },
          lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        });
      } else {
        accountMap.set(acc.refreshToken, acc);
      }
    }
  }

  return {
    version: 4,
    accounts: Array.from(accountMap.values()),
    activeIndex: incoming.activeIndex,
    activeIndexByFamily: incoming.activeIndexByFamily,
  };
}

export function deduplicateAccountsByEmail<T extends { email?: string; lastUsed?: number; addedAt?: number }>(
  accounts: T[],
): T[] {
  const emailToNewestIndex = new Map<string, number>();
  const indicesToKeep = new Set<number>();

  // First pass: find the newest account for each email (by lastUsed, then addedAt)
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (!acc) continue;

    if (!acc.email) {
      // No email - keep this account (can't deduplicate without email)
      indicesToKeep.add(i);
      continue;
    }

    const existingIndex = emailToNewestIndex.get(acc.email);
    if (existingIndex === undefined) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }

    // Compare to find which is newer
    const existing = accounts[existingIndex];
    if (!existing) {
      emailToNewestIndex.set(acc.email, i);
      continue;
    }

    // Prefer higher lastUsed, then higher addedAt
    // Compare fields separately to avoid integer overflow with large timestamps
    const currLastUsed = acc.lastUsed || 0;
    const existLastUsed = existing.lastUsed || 0;
    const currAddedAt = acc.addedAt || 0;
    const existAddedAt = existing.addedAt || 0;

    const isNewer =
      currLastUsed > existLastUsed || (currLastUsed === existLastUsed && currAddedAt > existAddedAt);

    if (isNewer) {
      emailToNewestIndex.set(acc.email, i);
    }
  }

  // Add all the newest email-based indices to the keep set
  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx);
  }

  // Build the deduplicated list, preserving original order for kept items
  const result: T[] = [];
  for (let i = 0; i < accounts.length; i++) {
    if (indicesToKeep.has(i)) {
      const acc = accounts[i];
      if (acc) {
        result.push(acc);
      }
    }
  }

  return result;
}

function migrateV1ToV2(v1: AccountStorageV1): AccountStorage {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitStateLegacy = {};
      if (acc.isRateLimited && acc.rateLimitResetTime && acc.rateLimitResetTime > Date.now()) {
        rateLimitResetTimes.claude = acc.rateLimitResetTime;
        rateLimitResetTimes.gemini = acc.rateLimitResetTime;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
      };
    }),
    activeIndex: v1.activeIndex,
  };
}

export function migrateV2ToV3(v2: AccountStorage): AccountStorageV3 {
  return {
    version: 3,
    accounts: v2.accounts.map((acc) => {
      const rateLimitResetTimes: RateLimitState = {};
      if (acc.rateLimitResetTimes?.claude && acc.rateLimitResetTimes.claude > Date.now()) {
        rateLimitResetTimes.claude = acc.rateLimitResetTimes.claude;
      }
      if (acc.rateLimitResetTimes?.gemini && acc.rateLimitResetTimes.gemini > Date.now()) {
        rateLimitResetTimes["gemini-antigravity"] = acc.rateLimitResetTimes.gemini;
      }
      return {
        email: acc.email,
        refreshToken: acc.refreshToken,
        projectId: acc.projectId,
        managedProjectId: acc.managedProjectId,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
      };
    }),
    activeIndex: v2.activeIndex,
  };
}

export function migrateV3ToV4(v3: AccountStorageV3): AccountStorageV4 {
  return {
    version: 4,
    accounts: v3.accounts.map((acc) => ({
      ...acc,
      fingerprint: undefined,
      fingerprintHistory: undefined,
    })),
    activeIndex: v3.activeIndex,
    activeIndexByFamily: v3.activeIndexByFamily,
  };
}

/**
 * Migrate any stored version (1-4) to the current V4 shape.
 * Returns null for unknown versions.
 */
function migrateToV4(data: AnyAccountStorage): AccountStorageV4 | null {
  switch (data.version) {
    case 1:
      return migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(data)));
    case 2:
      return migrateV3ToV4(migrateV2ToV3(data));
    case 3:
      return migrateV3ToV4(data);
    case 4:
      return data;
    default:
      return null;
  }
}

export type AccountsLoadErrorReason =
  | "permission"
  | "parse"
  | "invalid-format"
  | "unknown-version"
  | "read-error";

export type AccountsLoadResult =
  | { status: "ok"; storage: AccountStorageV4 }
  | { status: "not-found" }
  | { status: "error"; reason: AccountsLoadErrorReason };

export class AccountStorageUnreadableError extends Error {
  readonly reason: AccountsLoadErrorReason;
  readonly filePath: string;

  constructor(reason: AccountsLoadErrorReason, filePath: string) {
    const detail =
      reason === "permission"
        ? "permission denied"
        : reason === "parse"
          ? "invalid JSON"
          : reason === "invalid-format"
            ? "unexpected storage format"
            : reason === "unknown-version"
              ? "unsupported storage version"
              : "unexpected read error";
    super(
      `Cannot read account storage at ${filePath}: ${detail}. ` +
        `Your existing accounts were NOT modified. ` +
        `Fix the file permissions or contents, or move the file away to start fresh ` +
        `(you will need to re-authenticate).`,
    );
    this.name = "AccountStorageUnreadableError";
    this.reason = reason;
    this.filePath = filePath;
  }
}

/**
 * Loads account storage, distinguishing "file does not exist" (safe to create)
 * from real read/parse errors (dangerous to ignore because the caller might
 * silently overwrite existing accounts — Issue #89).
 */
async function readAccountsResult(persistMigration: boolean): Promise<AccountsLoadResult> {
  try {
    const path = getStoragePath();
    // Ensure permissions are correct on load (fixes existing files)
    await ensureSecurePermissions(path);

    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AnyAccountStorage;

    if (!Array.isArray(data.accounts)) {
      log.warn("Invalid storage format, ignoring");
      return { status: "error", reason: "invalid-format" };
    }

    const migrated = migrateToV4(data);
    if (!migrated) {
      log.warn("Unknown storage version, ignoring", {
        version: (data as { version?: unknown }).version,
      });
      return { status: "error", reason: "unknown-version" };
    }

    // Persist migrated storage so the next load is a fast path (v4).
    // Only from loadAccounts(); loadAccountsUnsafe() (used inside saveAccounts)
    // must not re-persist, otherwise migration loops forever.
    if (data.version !== 4 && persistMigration) {
      log.info(`Migrating account storage from v${data.version} to v4`);
      try {
        await saveAccounts(migrated);
        log.info("Migration to v4 complete");
      } catch (saveError) {
        log.warn("Failed to persist migrated storage", {
          error: String(saveError),
        });
      }
    }

    // Validate accounts have required fields
    const validAccounts = migrated.accounts.filter((a): a is AccountMetadataV3 => {
      return !!a && typeof a === "object" && typeof (a as AccountMetadataV3).refreshToken === "string";
    });

    // Deduplicate accounts by email (keeps newest entry for each email)
    const deduplicatedAccounts = deduplicateAccountsByEmail(validAccounts);

    // Clamp activeIndex to valid range after deduplication
    let activeIndex =
      typeof migrated.activeIndex === "number" && Number.isFinite(migrated.activeIndex)
        ? migrated.activeIndex
        : 0;
    if (deduplicatedAccounts.length > 0) {
      activeIndex = Math.min(activeIndex, deduplicatedAccounts.length - 1);
      activeIndex = Math.max(activeIndex, 0);
    } else {
      activeIndex = 0;
    }

    return {
      status: "ok",
      storage: {
        version: 4,
        accounts: deduplicatedAccounts,
        activeIndex,
        activeIndexByFamily: migrated.activeIndexByFamily,
      },
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: "error", reason: "parse" };
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "not-found" };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { status: "error", reason: "permission" };
    }
    log.error("Failed to load account storage", { error: String(error) });
    return { status: "error", reason: "read-error" };
  }
}

/**
 * Safe variant that never throws: callers that need to distinguish
 * "file missing" from "file unreadable" can branch on `status`.
 */
export async function loadAccountsSafe(): Promise<AccountsLoadResult> {
  return readAccountsResult(true);
}

export async function loadAccounts(): Promise<AccountStorageV4 | null> {
  const result = await readAccountsResult(true);
  if (result.status === "ok") {
    return result.storage;
  }
  if (result.status === "not-found") {
    return null;
  }
  throw new AccountStorageUnreadableError(result.reason, getStoragePath());
}

export async function saveAccounts(storage: AccountStorageV4): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const existing = await loadAccountsUnsafe();
    const merged = existing ? mergeAccountStorage(existing, storage) : storage;

    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(merged, null, 2);

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      // Clean up temp file on failure to prevent accumulation
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors (file may not exist)
      }
      throw error;
    }
  });
}

/**
 * Save accounts storage by replacing the entire file (no merge).
 * Use this for destructive operations like delete where we need to
 * remove accounts that would otherwise be merged back from existing storage.
 */
export async function saveAccountsReplace(storage: AccountStorageV4): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(storage, null, 2);

    try {
      await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, path);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  });
}

async function loadAccountsUnsafe(): Promise<AccountStorageV4 | null> {
  const result = await readAccountsResult(false);
  if (result.status === "ok") {
    return result.storage;
  }
  if (result.status === "not-found") {
    return null;
  }
  throw new AccountStorageUnreadableError(result.reason, getStoragePath());
}

export async function clearAccounts(): Promise<void> {
  try {
    const path = getStoragePath();
    await fs.unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error("Failed to clear account storage", { error: String(error) });
    }
  }
}
