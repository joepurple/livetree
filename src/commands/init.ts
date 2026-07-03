import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readLtConfig } from "../config.js";
import { CliError } from "../errors.js";
import { samePath } from "../path-utils.js";
import type { ProjectContext, WorktreeChoice } from "../types.js";
import { markWorktreeInitialized, uninitializedWorktreesNewestFirst } from "../worktrees.js";

export async function initWorktree(context: ProjectContext): Promise<void> {
  const config = readLtConfig(context);
  if (!config.initScript) {
    throw new CliError(
      `.ltconf must define an init script.\n\nSupported examples:\ninit:\n  copy:\n    - modules/api/.env\n  script: pnpm install\n\ninit:\n  script: |\n    corepack enable\n    pnpm install`,
    );
  }

  console.log(`Using init config: ${config.configPath}`);
  const targets = uninitializedWorktreesNewestFirst(context.choices);
  if (targets.length === 0) {
    console.log("No uninitialized worktrees found.");
    return;
  }

  console.log(`Initializing ${targets.length} worktree${targets.length === 1 ? "" : "s"}.`);
  for (const target of targets) {
    console.log(`\nInitializing: ${target.label}`);
    console.log(target.path);
    copyInitFiles(context, target, config.copyFiles);
    runInitScript(target, config.initScript);
    markWorktreeInitialized(target);
    console.log(`Initialized: ${target.label}`);
  }
}

function runInitScript(target: WorktreeChoice, script: string): void {
  console.log(`Running init in ${target.path}`);
  const result = spawnSync(script, {
    cwd: target.path,
    env: process.env,
    shell: true,
    stdio: "inherit",
  });

  if (result.error) {
    throw new CliError(`Init script failed to start: ${result.error.message}`);
  }

  if (result.signal) {
    throw new CliError(`Init script terminated by signal ${result.signal}.`);
  }

  if (result.status && result.status !== 0) {
    throw new CliError(`Init script exited with status ${result.status}.`, result.status);
  }
}

function copyInitFiles(context: ProjectContext, target: WorktreeChoice, copyFiles: string[]): void {
  if (copyFiles.length === 0) {
    return;
  }

  console.log(`Copying ${copyFiles.length} init file${copyFiles.length === 1 ? "" : "s"}`);
  for (const relativePath of copyFiles) {
    const sourcePath = path.join(context.mainRoot, relativePath);
    const targetPath = path.join(target.path, relativePath);

    if (samePath(sourcePath, targetPath)) {
      console.log(`skipped ${relativePath} (source and target are the same)`);
      continue;
    }

    if (!existsSync(sourcePath)) {
      console.log(`missing ${relativePath}`);
      continue;
    }

    if (!lstatSync(sourcePath).isFile()) {
      throw new CliError(`Init copy path is not a file: ${relativePath}`);
    }

    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    console.log(`copied ${relativePath}`);
  }
}
