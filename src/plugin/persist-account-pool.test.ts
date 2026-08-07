/**
 * Tests for persistAccountPool function
 *
 * Issue #89: Multi-account login overwrites existing accounts
 * Root cause: loadAccounts() returning null is treated as "no accounts"
 * even when the file exists but couldn't be read (permissions, corruption, etc.)
 */

import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { persistAccountPool } from "./account-pool";
import type { AccountMetadataV3, AccountStorageV4 } from "./storage";
import * as storageModule from "./storage";
import { AccountStorageUnreadableError, loadAccountsSafe } from "./storage";

vi.mock("proper-lockfile", () => ({
  default: {
    lock: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn(),
      rename: vi.fn().mockResolvedValue(undefined),
    },
  };
});

function createMockAccount(overrides: Partial<AccountMetadataV3> = {}): AccountMetadataV3 {
  return {
    email: "test@example.com",
    refreshToken: "test-refresh-token",
    projectId: "test-project-id",
    managedProjectId: "test-managed-project-id",
    addedAt: Date.now() - 10000,
    lastUsed: Date.now(),
    ...overrides,
  };
}

function createMockStorage(accounts: AccountMetadataV3[], activeIndex = 0): AccountStorageV4 {
  return {
    version: 4,
    accounts,
    activeIndex,
  };
}

function createSuccessResult(
  overrides: Partial<Extract<AntigravityTokenExchangeResult, { type: "success" }>> = {},
): Extract<AntigravityTokenExchangeResult, { type: "success" }> {
  return {
    type: "success",
    refresh: "new-token|project|managed",
    access: "",
    expires: 0,
    email: "new@example.com",
    projectId: "project",
    ...overrides,
  };
}

function lastWrittenStorage(): AccountStorageV4 {
  const call = vi.mocked(fs.writeFile).mock.calls.find((c) => (c[0] as string).includes(".tmp"));
  expect(call, "expected a .tmp writeFile call").toBeDefined();
  return JSON.parse(call![1] as string) as AccountStorageV4;
}

function mockReadStorage(storage: AccountStorageV4 | null): void {
  if (storage === null) {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValue(error);
  } else {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(storage));
  }
}

describe("loadAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("file not found (ENOENT)", () => {
    it("returns null when file does not exist", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const result = await storageModule.loadAccounts();

      expect(result).toBeNull();
    });
  });

  describe("file exists with valid data", () => {
    it("returns storage for valid V3 file", async () => {
      const mockStorage = createMockStorage([createMockAccount()]);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStorage));

      const result = await storageModule.loadAccounts();

      expect(result).not.toBeNull();
      expect(result?.version).toBe(4);
      expect(result?.accounts).toHaveLength(1);
    });

    it("returns storage with multiple accounts", async () => {
      const mockStorage = createMockStorage([
        createMockAccount({ email: "user1@example.com", refreshToken: "token1" }),
        createMockAccount({ email: "user2@example.com", refreshToken: "token2" }),
      ]);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStorage));

      const result = await storageModule.loadAccounts();

      expect(result?.accounts).toHaveLength(2);
      expect(result?.accounts[0]?.email).toBe("user1@example.com");
      expect(result?.accounts[1]?.email).toBe("user2@example.com");
    });

    it("preserves activeIndex from storage", async () => {
      const mockStorage = createMockStorage(
        [
          createMockAccount({ email: "user1@example.com" }),
          createMockAccount({ email: "user2@example.com" }),
        ],
        1,
      );
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStorage));

      const result = await storageModule.loadAccounts();

      expect(result?.activeIndex).toBe(1);
    });
  });

  describe("error handling - THE BUG (Issue #89)", () => {
    /**
     * FIXED: loadAccounts now distinguishes ENOENT (file missing → safe to create)
     * from real read/parse errors (file exists but unreadable → throw instead of
     * returning null, so callers never silently overwrite existing accounts).
     */

    it("throws AccountStorageUnreadableError on permission denied (EACCES)", async () => {
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountStorageUnreadableError);
    });

    it("throws AccountStorageUnreadableError on JSON parse error", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{ invalid json }}}");

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountStorageUnreadableError);
    });

    it("throws AccountStorageUnreadableError on invalid storage format", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: 4, notAccounts: [] }));

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountStorageUnreadableError);
    });

    it("throws AccountStorageUnreadableError on unknown version", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: 999, accounts: [] }));

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountStorageUnreadableError);
    });
  });

  describe("migration", () => {
    it("migrates V2 to V3 successfully", async () => {
      const v2Storage = {
        version: 2,
        accounts: [
          {
            refreshToken: "token1",
            addedAt: Date.now() - 10000,
            lastUsed: Date.now(),
          },
        ],
        activeIndex: 0,
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(v2Storage));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await storageModule.loadAccounts();

      expect(result?.version).toBe(4);
      expect(result?.accounts).toHaveLength(1);
    });
  });
});

describe("saveAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves valid storage to disk", async () => {
    mockReadStorage(null);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);

    const storage = createMockStorage([createMockAccount()]);
    await storageModule.saveAccounts(storage);

    const written = lastWrittenStorage();
    expect(written.version).toBe(4);
    expect(written.accounts).toHaveLength(1);
  });
});

/**
 * Tests for the expected behavior of persistAccountPool
 *
 * Issue #89: multi-account login must merge (not overwrite) existing accounts,
 * and unreadable storage must never be silently clobbered.
 */
describe("persistAccountPool behavior (Issue #89)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("merging behavior (replaceAll=false)", () => {
    it("merges new account with existing accounts", async () => {
      mockReadStorage(
        createMockStorage([
          createMockAccount({ email: "existing@example.com", refreshToken: "existing-token" }),
        ]),
      );

      await persistAccountPool([createSuccessResult()]);

      const storage = lastWrittenStorage();
      expect(storage.accounts).toHaveLength(2);
      const emails = storage.accounts.map((a) => a.email).sort();
      expect(emails).toEqual(["existing@example.com", "new@example.com"]);
    });

    it("deduplicates by email, keeping the newest token", async () => {
      const existing = createMockStorage([
        createMockAccount({ email: "new@example.com", refreshToken: "old-token", lastUsed: 0 }),
      ]);
      let current = JSON.stringify(existing);
      vi.mocked(fs.readFile).mockImplementation(async () => current);

      await persistAccountPool([createSuccessResult({ refresh: "new-token|project|managed" })]);

      // The written file may still carry the stale token (saveAccounts merges by
      // refresh token), but the next load must converge on a single account with
      // the newest token for that email.
      current = JSON.stringify(lastWrittenStorage());
      const reloaded = await storageModule.loadAccounts();
      expect(reloaded?.accounts).toHaveLength(1);
      expect(reloaded?.accounts[0]?.email).toBe("new@example.com");
      expect(reloaded?.accounts[0]?.refreshToken).toBe("new-token");
    });

    it("deduplicates by refresh token when email not available", async () => {
      mockReadStorage(
        createMockStorage([createMockAccount({ email: undefined, refreshToken: "shared-token" })]),
      );

      await persistAccountPool([
        createSuccessResult({ refresh: "shared-token|project|managed", email: undefined }),
      ]);

      const storage = lastWrittenStorage();
      expect(storage.accounts).toHaveLength(1);
      expect(storage.accounts[0]?.refreshToken).toBe("shared-token");
    });

    it("preserves activeIndex when adding new accounts", async () => {
      mockReadStorage(
        createMockStorage(
          [
            createMockAccount({ email: "a@example.com", refreshToken: "a-token" }),
            createMockAccount({ email: "b@example.com", refreshToken: "b-token" }),
          ],
          1,
        ),
      );

      await persistAccountPool([createSuccessResult()]);

      const storage = lastWrittenStorage();
      expect(storage.accounts).toHaveLength(3);
      expect(storage.activeIndex).toBe(1);
    });

    it("updates lastUsed timestamp for existing accounts", async () => {
      mockReadStorage(
        createMockStorage([
          createMockAccount({ email: "new@example.com", refreshToken: "old-token", lastUsed: 0 }),
        ]),
      );

      await persistAccountPool([createSuccessResult({ refresh: "new-token|project|managed" })]);

      const storage = lastWrittenStorage();
      const updated = storage.accounts.find((a) => a.refreshToken === "new-token");
      expect(updated).toBeDefined();
      expect(updated?.lastUsed).toBe(Date.now());
    });
  });

  describe("fresh start behavior (replaceAll=true)", () => {
    it("replaces all existing accounts with new ones", async () => {
      mockReadStorage(
        createMockStorage([
          createMockAccount({ email: "old1@example.com", refreshToken: "old1" }),
          createMockAccount({ email: "old2@example.com", refreshToken: "old2" }),
        ]),
      );

      await persistAccountPool([createSuccessResult()], true);

      const storage = lastWrittenStorage();
      expect(storage.accounts).toHaveLength(1);
      expect(storage.accounts[0]?.email).toBe("new@example.com");
    });

    it("resets activeIndex to 0", async () => {
      mockReadStorage(
        createMockStorage(
          [
            createMockAccount({ email: "a@example.com", refreshToken: "a" }),
            createMockAccount({ email: "b@example.com", refreshToken: "b" }),
          ],
          1,
        ),
      );

      await persistAccountPool([createSuccessResult()], true);

      const storage = lastWrittenStorage();
      expect(storage.activeIndex).toBe(0);
    });

    it("ignores existing accounts file even when unreadable", async () => {
      const eacces = new Error("EACCES") as NodeJS.ErrnoException;
      eacces.code = "EACCES";
      vi.mocked(fs.readFile).mockRejectedValue(eacces);

      await expect(persistAccountPool([createSuccessResult()], true)).resolves.not.toThrow();

      const storage = lastWrittenStorage();
      expect(storage.accounts).toHaveLength(1);
      expect(storage.accounts[0]?.email).toBe("new@example.com");
    });
  });

  describe("THE BUG: error handling when loadAccounts fails (Issue #89)", () => {
    it("does NOT overwrite accounts when loadAccounts fails due to permission error", async () => {
      const eacces = new Error("EACCES") as NodeJS.ErrnoException;
      eacces.code = "EACCES";
      vi.mocked(fs.readFile).mockRejectedValue(eacces);

      await expect(persistAccountPool([createSuccessResult()])).rejects.toThrow(
        AccountStorageUnreadableError,
      );
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("throws when file exists but cannot be read", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("boom"));

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountStorageUnreadableError);
    });

    it("only treats ENOENT as safe to create new file", async () => {
      mockReadStorage(null);

      await expect(persistAccountPool([createSuccessResult()])).resolves.not.toThrow();

      const storage = lastWrittenStorage();
      expect(storage.accounts).toHaveLength(1);
      expect(storage.accounts[0]?.email).toBe("new@example.com");
    });
  });
});

/**
 * Unit-level coverage of the TUI flow contract (Issue #89).
 *
 * The interactive warning/prompt UX ("should show warning when existing accounts
 * cannot be loaded", "should ask user for confirmation") lives in the TUI login
 * flow and is tracked separately; the data-safety core is covered here.
 */
describe("TUI flow integration (Issue #89)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  });

  describe("account persistence after OAuth", () => {
    it("should merge new account with existing accounts in TUI flow", async () => {
      mockReadStorage(
        createMockStorage([
          createMockAccount({ email: "existing@example.com", refreshToken: "existing-token" }),
        ]),
      );

      // TUI flow calls persistAccountPool with replaceAll=false.
      await persistAccountPool([createSuccessResult()], false);

      const storage = lastWrittenStorage();
      expect(storage.accounts).toHaveLength(2);
    });
  });

  describe("authorize function behavior", () => {
    it("should handle loadAccounts returning null (ENOENT) gracefully", async () => {
      mockReadStorage(null);

      await expect(persistAccountPool([createSuccessResult()], false)).resolves.not.toThrow();
    });
  });
});

/**
 * Regression tests to ensure the fix doesn't break normal operation
 */
describe("regression tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("first-time user experience", () => {
    it("should work correctly when no accounts file exists (ENOENT)", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const result = await storageModule.loadAccounts();
      expect(result).toBeNull();

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const newStorage = createMockStorage([createMockAccount()]);
      await expect(storageModule.saveAccounts(newStorage)).resolves.not.toThrow();
    });
  });

  describe("normal multi-account workflow", () => {
    it("should load existing accounts correctly", async () => {
      const existingStorage = createMockStorage([createMockAccount({ email: "existing@example.com" })]);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingStorage));

      const result = await storageModule.loadAccounts();

      expect(result).not.toBeNull();
      expect(result?.accounts).toHaveLength(1);
      expect(result?.accounts[0]?.email).toBe("existing@example.com");
    });

    it("should preserve all accounts when saving", async () => {
      const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
      enoent.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(enoent);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const storage = createMockStorage([
        createMockAccount({ email: "user1@example.com", refreshToken: "token1" }),
        createMockAccount({ email: "user2@example.com", refreshToken: "token2" }),
        createMockAccount({ email: "user3@example.com", refreshToken: "token3" }),
      ]);

      await storageModule.saveAccounts(storage);

      expect(fs.writeFile).toHaveBeenCalledTimes(2);

      const tmpWriteCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes(".tmp"));
      expect(tmpWriteCall).toBeDefined();
      const parsed = JSON.parse(tmpWriteCall![1] as string);
      expect(parsed.accounts).toHaveLength(3);

      const gitignoreWriteCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => (call[0] as string).includes(".gitignore"));
      expect(gitignoreWriteCall).toBeDefined();
    });
  });
});

/**
 * Fix validation tests
 *
 * These tests validate the enhanced error handling behavior.
 */
describe("fix validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loadAccountsSafe should distinguish error types", () => {
    it("returns not-found when file doesn't exist", async () => {
      mockReadStorage(null);

      const result = await loadAccountsSafe();

      expect(result).toEqual({ status: "not-found" });
    });

    it("returns permission error on EACCES", async () => {
      const eacces = new Error("EACCES") as NodeJS.ErrnoException;
      eacces.code = "EACCES";
      vi.mocked(fs.readFile).mockRejectedValue(eacces);

      const result = await loadAccountsSafe();

      expect(result).toEqual({ status: "error", reason: "permission" });
    });

    it("returns parse error on invalid JSON", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{ invalid json }}}");

      const result = await loadAccountsSafe();

      expect(result).toEqual({ status: "error", reason: "parse" });
    });

    it("returns invalid-format on schema mismatch", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: 4, notAccounts: [] }));

      const result = await loadAccountsSafe();

      expect(result).toEqual({ status: "error", reason: "invalid-format" });
    });

    it("returns unknown-version on unsupported storage version", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: 999, accounts: [] }));

      const result = await loadAccountsSafe();

      expect(result).toEqual({ status: "error", reason: "unknown-version" });
    });
  });

  describe("persistAccountPool should handle errors safely", () => {
    it("throws AccountStorageUnreadableError when file exists but can't be read", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("boom"));

      await expect(persistAccountPool([createSuccessResult()])).rejects.toThrow(
        AccountStorageUnreadableError,
      );
    });

    it("includes recovery instructions in the error message", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{ not json }");

      await expect(storageModule.loadAccounts()).rejects.toThrow(/NOT modified/);
    });
  });
});
