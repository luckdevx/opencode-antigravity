/**
 * Gitignore management for the config directory.
 *
 * Keeps sensitive/cache files out of version control if the config directory
 * itself lives inside a repository.
 */

import { appendFileSync, existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("gitignore");

const GITIGNORE_ENTRIES = [
  ".gitignore",
  "antigravity-accounts.json",
  "antigravity-accounts.json.*.tmp",
  "antigravity-signature-cache.json",
  "antigravity-logs/",
];

/**
 * Ensures a .gitignore file exists in the config directory with entries
 * for sensitive files. Creates the file if missing, or appends missing
 * entries if it already exists.
 */
export async function ensureGitignore(configDir: string): Promise<void> {
  const gitignorePath = join(configDir, ".gitignore");

  try {
    let content: string;
    let existingLines: string[] = [];

    try {
      content = await fs.readFile(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
      content = "";
    }

    const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !existingLines.includes(entry));

    if (missingEntries.length === 0) {
      return;
    }

    if (content === "") {
      await fs.writeFile(gitignorePath, `${missingEntries.join("\n")}\n`, "utf-8");
      log.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      await fs.appendFile(gitignorePath, `${suffix}${missingEntries.join("\n")}\n`, "utf-8");
      log.info("Updated .gitignore with missing entries", {
        added: missingEntries,
      });
    }
  } catch {
    // Non-critical feature
  }
}

/**
 * Synchronous version of ensureGitignore for use in sync code paths.
 */
export function ensureGitignoreSync(configDir: string): void {
  const gitignorePath = join(configDir, ".gitignore");

  try {
    let content: string;
    let existingLines: string[] = [];

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    } else {
      content = "";
    }

    const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !existingLines.includes(entry));

    if (missingEntries.length === 0) {
      return;
    }

    if (content === "") {
      writeFileSync(gitignorePath, `${missingEntries.join("\n")}\n`, "utf-8");
      log.info("Created .gitignore in config directory");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, `${suffix}${missingEntries.join("\n")}\n`, "utf-8");
      log.info("Updated .gitignore with missing entries", {
        added: missingEntries,
      });
    }
  } catch {
    // Non-critical feature
  }
}
