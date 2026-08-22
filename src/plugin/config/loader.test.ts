import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfigWithWarnings } from "./loader";
import { DEFAULT_CONFIG } from "./schema";

/**
 * Tests for warning surfacing in the config loader.
 *
 * The user config path is controlled via OPENCODE_CONFIG_DIR (read on every
 * call by paths.ts); the project-level path is derived from the `directory`
 * argument passed to loadConfigWithWarnings.
 */
describe("loadConfigWithWarnings", () => {
  let configDir: string;
  let projectDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "antigravity-config-"));
    projectDir = mkdtempSync(join(tmpdir(), "antigravity-project-"));
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const userConfigPath = () => join(configDir, "antigravity.json");

  it("returns defaults and no warnings when no config files exist", () => {
    const { config, warnings } = loadConfigWithWarnings(projectDir);

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });

  it("merges valid config without warnings", () => {
    writeFileSync(userConfigPath(), JSON.stringify({ debug: true, quiet_mode: true }));

    const { config, warnings } = loadConfigWithWarnings(projectDir);

    expect(config.debug).toBe(true);
    expect(config.quiet_mode).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("reports invalid values and falls back to defaults for the whole file", () => {
    writeFileSync(userConfigPath(), JSON.stringify({ debug: "yes" }));

    const { config, warnings } = loadConfigWithWarnings(projectDir);

    // Invalid file is ignored entirely - defaults apply
    expect(config.debug).toBe(DEFAULT_CONFIG.debug);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(userConfigPath());
    expect(warnings[0]).toContain("debug");
  });

  it("reports invalid JSON", () => {
    writeFileSync(userConfigPath(), "{ not valid json !!");

    const { config, warnings } = loadConfigWithWarnings(projectDir);

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Invalid JSON");
    expect(warnings[0]).toContain(userConfigPath());
  });

  it("reports unknown keys as likely typos while keeping known keys", () => {
    writeFileSync(
      userConfigPath(),
      JSON.stringify({ debug: true, scheduling_mod: "balance", quiot_mode: false }),
    );

    const { config, warnings } = loadConfigWithWarnings(projectDir);

    // Known keys still apply
    expect(config.debug).toBe(true);
    // Unknown keys are reported (typo'd key name and typo'd variant of quiet_mode)
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("scheduling_mod");
    expect(warnings[0]).toContain("quiot_mode");
  });

  it("collects warnings from both user and project config files", () => {
    writeFileSync(userConfigPath(), JSON.stringify({ debug: "nope" }));
    const projectConfigDir = join(projectDir, ".opencode");
    rmSync(projectConfigDir, { recursive: true, force: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, "antigravity.json"), "{ broken");

    const { warnings } = loadConfigWithWarnings(projectDir);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(userConfigPath());
    expect(warnings[1]).toContain(join(projectConfigDir, "antigravity.json"));
  });

  it("loadConfig keeps returning only the merged config (back-compat)", async () => {
    writeFileSync(userConfigPath(), JSON.stringify({ debug: true }));

    // Dynamic import to exercise the same module surface plugin.ts used before
    const { loadConfig } = await import("./loader");
    const config = loadConfig(projectDir);

    expect(config.debug).toBe(true);
  });
});
