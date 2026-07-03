import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const distRoot = path.join(repoRoot, "dist");
export const cliPath = path.join(distRoot, "cli.js");

export function tempDir(prefix, t) {
  const directory = path.join(os.tmpdir(), `livetree-${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  const realDirectory = realpathSync(directory);
  t?.after(() => rmSync(realDirectory, { recursive: true, force: true }));
  return realDirectory;
}

export function createGitRepo(t, prefix = "repo") {
  const root = tempDir(prefix, t);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
  writeFileSync(path.join(root, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

  try {
    execFileSync("git", ["branch", "-M", "main"], { cwd: root, stdio: "ignore" });
  } catch {
    // Older Git versions may already leave the default branch in a usable state.
  }

  return root;
}

export function makeChoice(overrides = {}) {
  return {
    path: overrides.path ?? "/tmp/worktree",
    head: overrides.head ?? null,
    branch: overrides.branch ?? null,
    bare: overrides.bare ?? false,
    prunable: overrides.prunable ?? null,
    label: overrides.label ?? "worktree",
    ref: overrides.ref ?? overrides.branch ?? null,
    chat: overrides.chat ?? null,
    isMain: overrides.isMain ?? false,
  };
}

export function makeContext(root, choices = []) {
  return {
    cwd: root,
    currentRoot: root,
    commonDir: path.join(root, ".git"),
    mainRoot: root,
    liveDir: path.join(root, ".livetree"),
    srcLink: path.join(root, ".livetree", "src"),
    stateFile: path.join(root, ".livetree", ".source"),
    choices,
  };
}

export async function withEnv(updates, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function withProperty(object, key, value, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, {
    configurable: true,
    value,
    writable: true,
  });

  try {
    return await callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(object, key, descriptor);
    } else {
      delete object[key];
    }
  }
}

export async function captureConsole(callback) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => {
    logs.push(args.join(" "));
  };

  try {
    const value = await callback();
    return { logs, value };
  } finally {
    console.log = original;
  }
}

export function fileExists(file) {
  return existsSync(file);
}

export class FakeTTYStdin extends EventEmitter {
  isTTY = true;
  rawMode = false;
  resumed = false;
  paused = false;

  setRawMode(value) {
    this.rawMode = value;
  }

  resume() {
    this.resumed = true;
    this.paused = false;
  }

  pause() {
    this.paused = true;
    this.resumed = false;
  }
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withMutedTerminal(callback) {
  const originalWrite = process.stderr.write;
  const originalRows = process.stderr.rows;
  process.stderr.write = () => true;
  process.stderr.rows = 10;

  try {
    return await callback();
  } finally {
    process.stderr.write = originalWrite;
    process.stderr.rows = originalRows;
  }
}
