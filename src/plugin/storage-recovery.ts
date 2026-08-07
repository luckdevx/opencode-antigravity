/**
 * Interactive recovery for unreadable account storage (Issue #89).
 *
 * When the accounts file exists but cannot be read (permission, corrupt JSON,
 * unknown version, ...), the plugin must never silently overwrite it. This
 * module surfaces the problem to the user and offers three safe actions:
 *
 *   r) Retry     — attempt loading again (transient errors)
 *   b) Backup    — move the file aside and continue fresh (nothing is deleted)
 *   a) Abort     — stop without touching anything
 *
 * In non-TTY environments (CI, headless) it never prompts: it aborts.
 */

import { promises as fs } from "node:fs";
import { createLogger } from "./logger";
import type { AccountStorageV4, AccountsLoadErrorReason, AccountsLoadResult } from "./storage";
import { AccountStorageUnreadableError, getStoragePath, loadAccountsSafe } from "./storage";

const log = createLogger("storage-recovery");

export type StorageRecoveryAction = "retry" | "backup" | "abort";

export type StorageRecoveryOutcome =
  | { action: "ok"; storage: AccountStorageV4 | null }
  | { action: "backup"; backupPath: string }
  | { action: "abort" };

function describeReason(reason: AccountsLoadErrorReason): string {
  switch (reason) {
    case "permission":
      return "permission denied";
    case "parse":
      return "invalid JSON";
    case "invalid-format":
      return "unexpected storage format";
    case "unknown-version":
      return "unsupported storage version";
    case "read-error":
      return "unexpected read error";
  }
}

export async function askFromReadline(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = process;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Asks the user how to proceed when account storage is unreadable.
 * Never prompts when there is no TTY; in that case it returns "abort".
 */
export async function promptStorageRecovery(
  error: AccountStorageUnreadableError,
  ask: (question: string) => Promise<string> = askFromReadline,
): Promise<StorageRecoveryAction> {
  if (!process.stdin.isTTY) {
    log.warn("Account storage unreadable and no TTY available; aborting to avoid data loss", {
      reason: error.reason,
    });
    return "abort";
  }

  console.warn("\n⚠️  Cannot read the accounts file:");
  console.warn(`    ${error.filePath}`);
  console.warn(`    Reason: ${describeReason(error.reason)}`);
  console.warn("    Your existing accounts were NOT modified.");
  console.warn("");
  console.warn("    (r) Retry        (b) Backup & continue        (a) Abort");

  while (true) {
    const answer = (await ask("    What do you want to do? [r/b/a]: ")).trim().toLowerCase();
    if (answer === "r" || answer === "retry") return "retry";
    if (answer === "b" || answer === "backup") return "backup";
    if (answer === "a" || answer === "abort" || answer === "") return "abort";
    console.warn("    Invalid choice. Enter r, b or a.");
  }
}

async function backupFile(filePath: string): Promise<string> {
  const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:\\.]/g, "-")}`;
  await fs.rename(filePath, backupPath);
  log.info("Backed up unreadable account storage", { backupPath });
  return backupPath;
}

export interface StorageRecoveryDeps {
  ask?: (question: string) => Promise<string>;
  reload?: () => Promise<AccountsLoadResult>;
  backup?: (filePath: string) => Promise<string>;
  maxRetries?: number;
}

/**
 * Handles an unreadable accounts file end to end: prompts, and on user choice
 * either retries loading, moves the file aside (backup) or aborts. Retries are
 * bounded; after exhausting them the user is nudged toward backup/abort.
 */
export async function recoverUnreadableStorage(
  error: AccountStorageUnreadableError,
  deps: StorageRecoveryDeps = {},
): Promise<StorageRecoveryOutcome> {
  const ask = deps.ask ?? askFromReadline;
  const reload = deps.reload ?? loadAccountsSafe;
  const backup = deps.backup ?? backupFile;
  const maxRetries = deps.maxRetries ?? 3;

  let current = error;
  let retries = 0;

  while (true) {
    const choice = await promptStorageRecovery(current, ask);

    if (choice === "backup") {
      const backupPath = await backup(current.filePath);
      return { action: "backup", backupPath };
    }
    if (choice === "abort") {
      return { action: "abort" };
    }

    retries++;
    const result = await reload();
    if (result.status === "ok") {
      return { action: "ok", storage: result.storage };
    }
    if (result.status === "not-found") {
      return { action: "ok", storage: null };
    }
    if (retries >= maxRetries) {
      console.warn("    Still unreadable after several retries. Choose (b) backup or (a) abort.");
    }
    current = new AccountStorageUnreadableError(result.reason, getStoragePath());
  }
}
