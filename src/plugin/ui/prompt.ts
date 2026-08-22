/**
 * Lightweight CLI text prompt utility.
 *
 * Uses `node:readline/promises` to read a single line of trimmed input from
 * stdin. Safe for interactive flows (OAuth callback paste, verification prompts).
 */
export async function promptCliText(message: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}
