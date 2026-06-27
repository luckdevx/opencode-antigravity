import { appendFileSync, existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(undefined),
      appendFile: vi.fn(),
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
});

describe("ensureGitignore", () => {
  const configDir = "/tmp/opencode-test";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates .gitignore when file does not exist", async () => {
    vi.mocked(fs.readFile).mockRejectedValue({ code: "ENOENT" });

    const { ensureGitignore } = await import("./gitignore");
    await ensureGitignore(configDir);

    expect(fs.writeFile).toHaveBeenCalled();
    const [path, content] = vi.mocked(fs.writeFile).mock.calls[0]!;
    expect(path).toContain(".gitignore");
    expect(content).toContain("antigravity-accounts.json");
    expect(content).toContain("antigravity-signature-cache.json");
    expect(content).toContain("antigravity-logs/");
  });

  it("appends missing entries to existing .gitignore", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("existing-entry");

    const { ensureGitignore } = await import("./gitignore");
    await ensureGitignore(configDir);

    expect(fs.appendFile).toHaveBeenCalled();
    const [path, content] = vi.mocked(fs.appendFile).mock.calls[0]!;
    expect(path).toContain(".gitignore");
    expect(content).toContain("antigravity-accounts.json");
    expect((content as string).startsWith("\n")).toBe(true);
  });

  it("does nothing when all entries already exist", async () => {
    const existing = [
      ".gitignore",
      "antigravity-accounts.json",
      "antigravity-accounts.json.*.tmp",
      "antigravity-signature-cache.json",
      "antigravity-logs/",
    ].join("\n");
    vi.mocked(fs.readFile).mockResolvedValue(existing);

    const { ensureGitignore } = await import("./gitignore");
    await ensureGitignore(configDir);

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.appendFile).not.toHaveBeenCalled();
  });

  it("handles permission errors gracefully", async () => {
    vi.mocked(fs.readFile).mockRejectedValue({ code: "EACCES" });

    const { ensureGitignore } = await import("./gitignore");
    await expect(ensureGitignore(configDir)).resolves.not.toThrow();

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.appendFile).not.toHaveBeenCalled();
  });
});

describe("ensureGitignoreSync", () => {
  const configDir = "/tmp/opencode-test-sync";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates .gitignore when file does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const { ensureGitignoreSync } = await import("./gitignore");
    ensureGitignoreSync(configDir);

    expect(writeFileSync).toHaveBeenCalled();
    const [path, content] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(path).toContain(".gitignore");
    expect(content).toContain("antigravity-accounts.json");
    expect(content).toContain("antigravity-signature-cache.json");
    expect(content).toContain("antigravity-logs/");
  });

  it("appends missing entries to existing .gitignore", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("existing-entry");

    const { ensureGitignoreSync } = await import("./gitignore");
    ensureGitignoreSync(configDir);

    expect(appendFileSync).toHaveBeenCalled();
    const [path, content] = vi.mocked(appendFileSync).mock.calls[0]!;
    expect(path).toContain(".gitignore");
    expect(content).toContain("antigravity-accounts.json");
    expect((content as string).startsWith("\n")).toBe(true);
  });

  it("does nothing when all entries already exist", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const existing = [
      ".gitignore",
      "antigravity-accounts.json",
      "antigravity-accounts.json.*.tmp",
      "antigravity-signature-cache.json",
      "antigravity-logs/",
    ].join("\n");
    vi.mocked(readFileSync).mockReturnValue(existing);

    const { ensureGitignoreSync } = await import("./gitignore");
    ensureGitignoreSync(configDir);

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it("handles permission errors gracefully", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const { ensureGitignoreSync } = await import("./gitignore");
    expect(() => ensureGitignoreSync(configDir)).not.toThrow();

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(appendFileSync).not.toHaveBeenCalled();
  });
});
