#!/usr/bin/env node
/**
 * One-command first run.
 *
 * Verifies the tools this app shells out to (Node, ffmpeg, and the Rust
 * toolchain used to build the desktop shell), installs JS dependencies, and
 * prints exactly what to run next. It never installs system packages for you:
 * it tells you the one command to run instead.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const ok = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const bad = (m) => console.log(`${C.red}✗${C.reset} ${m}`);

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: isWindows });
}

function hasCommand(cmd) {
  const probe = isWindows ? run("where", [cmd]) : run("which", [cmd]);
  return probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
}

function loadEnvFile() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return false;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  if (hasCommand("ffmpeg")) return "ffmpeg";
  return null;
}

function main() {
  console.log(`\n${C.bold}${C.cyan}Screen Studio (local) — first run${C.reset}\n`);

  const envLoaded = loadEnvFile();
  console.log(
    envLoaded
      ? `${C.dim}Loaded configuration from .env${C.reset}`
      : `${C.dim}No .env found (optional — copy .env.example to override defaults)${C.reset}`,
  );
  console.log();

  // Node
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 20) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} is too old — install Node 20 or newer`);

  // ffmpeg
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    const v = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], {
      encoding: "utf8",
      shell: isWindows,
    });
    const version = (v.stdout ?? "").split("\n")[0];
    ok(`ffmpeg: ${version || ffmpeg}`);
  } else {
    bad("ffmpeg not found — required for export and poster frames");
    warn(
      isWindows
        ? "Install it with:  winget install --id Gyan.FFmpeg -e"
        : process.platform === "darwin"
          ? "Install it with:  brew install ffmpeg"
          : "Install it with:  sudo apt install ffmpeg",
    );
    warn("Then re-run this command (a new terminal refreshes PATH).");
  }

  // Rust toolchain (needed to build the desktop shell)
  const hasCargo = hasCommand("cargo");
  if (hasCargo) {
    const v = run("cargo", ["--version"]);
    ok(`Rust: ${(v.stdout ?? "").trim()}`);
  } else {
    warn("Rust/cargo not found — needed to build/run the desktop app");
    warn("Install it from https://rustup.rs (then restart your terminal).");
    if (isWindows) {
      warn("Windows also needs the MSVC C++ build tools (Desktop development with C++).");
    }
  }

  // Install JS dependencies
  console.log();
  const hasModules = existsSync(join(root, "node_modules"));
  const pkgManager = hasCommand("pnpm") ? "pnpm" : hasCommand("npm") ? "npm" : null;
  if (!pkgManager) {
    bad("Neither pnpm nor npm found.");
  } else {
    console.log(`${C.bold}Installing JavaScript dependencies (${pkgManager})…${C.reset}`);
    const install = run(pkgManager, ["install"]);
    if (install.status === 0 && (hasModules || true)) ok("Dependencies installed");
    else bad("Dependency install failed — see output above");
  }

  // Summary
  console.log(`\n${C.bold}${C.cyan}Next steps${C.reset}`);
  if (ffmpeg && pkgManager) {
    console.log(`  ${C.bold}Run the app:${C.reset}   ${pkgManager} run first-run   ${C.dim}(opens the desktop app)${C.reset}`);
    console.log(`  ${C.bold}UI only:${C.reset}      ${pkgManager} run dev          ${C.dim}(browser preview; no export)${C.reset}`);
    console.log(`  ${C.bold}Tests:${C.reset}        ${pkgManager} test`);
  } else {
    console.log("  Fix the ✗ items above, then re-run this command.");
  }
  if (!hasCargo) {
    console.log(
      `\n  ${C.yellow}Note:${C.reset} the desktop app needs Rust. Until then use "${pkgManager ?? "pnpm"} run dev" for the UI.`,
    );
  }

  const dataDir =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? "", "com.local.screenstudio")
      : process.platform === "darwin"
        ? join(os.homedir(), "Library", "Application Support", "com.local.screenstudio")
        : join(process.env.XDG_DATA_HOME ?? join(os.homedir(), ".local", "share"), "com.local.screenstudio");

  console.log(`\n${C.dim}Recordings and exports are stored in:${C.reset}\n  ${dataDir}`);
  console.log(`${C.dim}Everything stays on this machine. No accounts, no cloud.${C.reset}\n`);

  process.exit(ffmpeg && pkgManager ? 0 : 1);
}

main();
