/**
 * Tests for interactive storage recovery (Issue #89): retry / backup / abort
 * when the accounts file exists but cannot be read.
 */

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountStorageUnreadableError, type AccountStorageV4 } from "./storage";
import { promptStorageRecovery, recoverUnreadableStorage } from "./storage-recovery";

function setTty(value: boolean): void {
  if (process.stdin) {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
  }
}

function queuedAsk(answers: string[]): (question: string) => Promise<string> {
  let i = 0;
  return async () => answers[Math.min(i++, answers.length - 1)] ?? "";
}

const UNREADABLE = new AccountStorageUnreadableError("parse", "/tmp/accounts.json");

describe("promptStorageRecovery", () => {
  beforeEach(() => {
    setTty(true);
  });

  afterEach(() => {
    setTty(false);
  });

  it("returns abort in non-TTY environments without prompting", async () => {
    setTty(false);
    let asked = false;
    const action = await promptStorageRecovery(UNREADABLE, async () => {
      asked = true;
      return "r";
    });
    expect(action).toBe("abort");
    expect(asked).toBe(false);
  });

  it("maps single-letter answers to actions", async () => {
    expect(await promptStorageRecovery(UNREADABLE, queuedAsk(["r"]))).toBe("retry");
    expect(await promptStorageRecovery(UNREADABLE, queuedAsk(["b"]))).toBe("backup");
    expect(await promptStorageRecovery(UNREADABLE, queuedAsk(["a"]))).toBe("abort");
  });

  it("accepts long-form answers", async () => {
    expect(await promptStorageRecovery(UNREADABLE, queuedAsk(["retry"]))).toBe("retry");
    expect(await promptStorageRecovery(UNREADABLE, queuedAsk(["backup"]))).toBe("backup");
    expect(await promptStorageRecovery(UNREADABLE, queuedAsk(["abort"]))).toBe("abort");
  });

  it("defaults an empty answer to abort", async () => {
    expect(await promptStorageRecovery(UNREADABLE, queuedAsk([""]))).toBe("abort");
  });

  it("loops until a valid answer is given", async () => {
    const action = await promptStorageRecovery(UNREADABLE, queuedAsk(["x", "??", "b"]));
    expect(action).toBe("backup");
  });
});

describe("recoverUnreadableStorage", () => {
  beforeEach(() => {
    setTty(true);
  });

  afterEach(() => {
    setTty(false);
  });

  it("aborts without reloading or touching the file", async () => {
    let reloaded = false;
    const outcome = await recoverUnreadableStorage(UNREADABLE, {
      ask: queuedAsk(["a"]),
      reload: async () => {
        reloaded = true;
        return { status: "error", reason: "parse" };
      },
    });
    expect(outcome).toEqual({ action: "abort" });
    expect(reloaded).toBe(false);
  });

  it("retries loading when the user chooses retry and storage becomes readable", async () => {
    const storage: AccountStorageV4 = { version: 4, accounts: [], activeIndex: 0 };
    const outcome = await recoverUnreadableStorage(UNREADABLE, {
      ask: queuedAsk(["r"]),
      reload: async () => ({ status: "ok", storage }),
    });
    expect(outcome).toEqual({ action: "ok", storage });
  });

  it("treats a vanished file as a fresh start", async () => {
    const outcome = await recoverUnreadableStorage(UNREADABLE, {
      ask: queuedAsk(["r"]),
      reload: async () => ({ status: "not-found" }),
    });
    expect(outcome).toEqual({ action: "ok", storage: null });
  });

  it("backs up by moving the unreadable file aside (real rename)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smx-recovery-"));
    const file = join(dir, "accounts.json");
    writeFileSync(file, "{ broken json");

    const outcome = await recoverUnreadableStorage(new AccountStorageUnreadableError("parse", file), {
      ask: queuedAsk(["b"]),
      reload: async () => ({ status: "error", reason: "parse" }),
    });

    expect(outcome.action).toBe("backup");
    expect(existsSync(file)).toBe(false);
    const remaining = readdirSync(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!).toMatch(/^accounts\.json\.bak-/);
  });

  it("bounds retries and keeps prompting until a final choice", async () => {
    let reloads = 0;
    const backup = vi.fn(async (path: string) => `${path}.bak`);
    const outcome = await recoverUnreadableStorage(UNREADABLE, {
      ask: queuedAsk(["r", "r", "r", "r", "r", "b"]),
      maxRetries: 3,
      reload: async () => {
        reloads++;
        return { status: "error", reason: "permission" };
      },
      backup,
    });

    if (outcome.action === "backup") {
      expect(outcome.backupPath).toMatch(/\.bak$/);
      expect(backup).toHaveBeenCalledTimes(1);
    } else {
      expect.fail("expected a backup outcome");
    }
    expect(reloads).toBe(5);
  });
});
