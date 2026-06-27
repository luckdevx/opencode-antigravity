/**
 * Environment detection and browser opening helpers.
 *
 * Extracted from the main plugin entrypoint: these functions determine
 * whether we're running in a remote/WSL environment (where a local OAuth
 * callback server may not be reachable) and how to open a browser.
 */

import { exec } from "node:child_process";

export function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const { readFileSync } = require("node:fs");
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

export function isWSL2(): boolean {
  if (!isWSL()) return false;
  try {
    const { readFileSync } = require("node:fs");
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}

export function isRemoteEnvironment(): boolean {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true;
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSL()) {
    return true;
  }
  return false;
}

export function shouldSkipLocalServer(): boolean {
  return isWSL2() || isRemoteEnvironment();
}

export async function openBrowser(url: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      exec(`open "${url}"`);
      return true;
    }
    if (process.platform === "win32") {
      exec(`start "" "${url}"`);
      return true;
    }
    if (isWSL()) {
      try {
        exec(`wslview "${url}"`);
        return true;
      } catch {}
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return false;
    }
    exec(`xdg-open "${url}"`);
    return true;
  } catch {
    return false;
  }
}
