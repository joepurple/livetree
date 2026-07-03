#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import fuzzysort from "fuzzysort";
import { parse as parseYaml } from "yaml";

type WorktreeRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  prunable: string | null;
};

type CodexChat = {
  title: string;
  threadId: string;
};

type WorktreeChoice = WorktreeRecord & {
  label: string;
  ref: string | null;
  chat: CodexChat | null;
  isMain: boolean;
};

type ProjectContext = {
  cwd: string;
  currentRoot: string;
  commonDir: string;
  mainRoot: string;
  liveDir: string;
  srcLink: string;
  stateFile: string;
  choices: WorktreeChoice[];
};

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

class WorktreeRemoveNeedsForceError extends CliError {}
class WorktreeRemovePrunableError extends CliError {}

const usage = `Usage:
  livetree
  livetree use [selector]
  livetree switch [selector]
  livetree <script-name> [args...]
  livetree list
  livetree ls
  livetree init
  livetree run <script-name> [args...]
  livetree watch <script-name> [args...]
  livetree rm
  livetree remove
  livetree delete

Use 'livetree switch <selector>' to select a worktree by branch name,
worktree directory name, commit prefix, path, Codex thread id prefix, or
Codex chat title fragment.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0 && ["-h", "--help", "help"].includes(args[0] ?? "")) {
    console.log(usage);
    return;
  }

  const context = buildProjectContext(process.cwd());
  if (context.choices.length === 0) {
    throw new CliError("No worktrees found for this project.");
  }

  if (args[0] === "init") {
    if (args.length > 1) {
      throw new CliError("Usage: livetree init");
    }

    await initWorktree(context);
    return;
  }

  if (["list", "ls"].includes(args[0] ?? "")) {
    if (args.length > 1) {
      throw new CliError("Usage: livetree list");
    }

    listWorktrees(context);
    return;
  }

  if (args[0] === "run") {
    await runConfiguredScript(context, args.slice(1), false);
    return;
  }

  if (args[0] === "watch") {
    await runConfiguredScript(context, args.slice(1), true);
    return;
  }

  if (["use", "switch"].includes(args[0] ?? "")) {
    const selector = args.slice(1).join(" ").trim();
    const target = selector ? resolveSelector(context, selector) : await selectWorktree(context);
    switchSource(context, target);
    return;
  }

  if (["rm", "remove", "delete"].includes(args[0] ?? "")) {
    if (args.length > 1) {
      throw new CliError("Usage: livetree rm");
    }

    await removeWorktrees(context);
    return;
  }

  if (args.length > 0) {
    await runConfiguredScript(context, args, false, { shortcut: true });
    return;
  }

  const target = await selectWorktree(context);
  switchSource(context, target);
}

function buildProjectContext(cwd: string): ProjectContext {
  const currentRoot = git(["rev-parse", "--show-toplevel"], cwd, "livetree must be run inside a Git worktree.");
  const commonDir = gitCommonDir(currentRoot);
  const records = parseWorktreeList(git(["--git-dir", commonDir, "worktree", "list", "--porcelain"], currentRoot));
  const worktrees = records.filter((record) => !record.bare);
  const mainRoot = worktrees[0]?.path;

  if (!mainRoot) {
    throw new CliError("No non-bare worktrees found for this project.");
  }

  const liveDir = path.join(mainRoot, ".livetree");
  const srcLink = path.join(liveDir, "src");
  const stateFile = path.join(liveDir, ".source");
  const choices = worktrees.map((record, index) => enrichWorktree(record, index === 0));

  return {
    cwd,
    currentRoot,
    commonDir,
    mainRoot,
    liveDir,
    srcLink,
    stateFile,
    choices,
  };
}

function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  const blocks = output.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);

  for (const block of blocks) {
    let worktreePath: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let bare = false;
    let prunable: string | null = null;

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = stripHeadsPrefix(line.slice("branch ".length));
      } else if (line === "bare") {
        bare = true;
      } else if (line.startsWith("prunable")) {
        prunable = line.slice("prunable".length).trim() || "prunable";
      }
    }

    if (worktreePath) {
      records.push({ path: worktreePath, head, branch, bare, prunable });
    }
  }

  return records;
}

function enrichWorktree(record: WorktreeRecord, isMain: boolean): WorktreeChoice {
  if (isMain) {
    const ref = refForWorktree(record);
    return {
      ...record,
      isMain,
      chat: null,
      ref,
      label: ref ? `ROOT [${ref}]` : "ROOT",
    };
  }

  const chat = codexChatForPath(record.path);
  const ref = refForWorktree(record);
  let label: string;

  if (chat?.title && ref) {
    label = `${chat.title} [${ref}]`;
  } else if (chat?.title) {
    label = chat.title;
  } else if (ref) {
    label = `[${ref}]`;
  } else {
    label = path.basename(record.path);
  }

  return {
    ...record,
    isMain,
    chat,
    ref,
    label,
  };
}

function refForWorktree(record: WorktreeRecord): string | null {
  if (record.branch) {
    return record.branch;
  }

  const synced = syncedBranchForPath(record.path);
  if (synced) {
    return synced;
  }

  if (record.head && !/^0+$/.test(record.head)) {
    return `detached:${record.head.slice(0, 12)}`;
  }

  return null;
}

function resolveSelector(context: ProjectContext, selector: string): WorktreeChoice {
  const directPath = resolveExistingPath(selector, context.cwd);
  const lowerSelector = selector.toLowerCase();
  const matches = context.choices.filter((choice) => {
    const branch = choice.branch ?? "";
    const head = choice.head ?? "";
    const basename = path.basename(choice.path);
    const title = choice.chat?.title.toLowerCase() ?? "";
    const threadId = choice.chat?.threadId ?? "";

    return (
      choice.path === selector ||
      normalizePath(choice.path) === normalizePath(selector) ||
      (directPath !== null && samePath(choice.path, directPath)) ||
      basename === selector ||
      branch === selector ||
      head.startsWith(selector) ||
      threadId.startsWith(selector) ||
      title.includes(lowerSelector)
    );
  });

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1) {
    throw new CliError(`More than one worktree matched '${selector}':\n${formatChoiceList(matches, activeSource(context))}`);
  }

  throw new CliError(`No worktree matched '${selector}'.`);
}

async function selectWorktree(context: ProjectContext): Promise<WorktreeChoice> {
  const active = activeSource(context);

  if (!process.stdin.isTTY) {
    throw new CliError(`Choose a worktree with 'livetree switch <selector>'. Available worktrees:\n${formatNumberedChoiceList(context.choices, active)}`);
  }

  const [selected] = await selectFromInteractiveWorktreeList({
    active,
    items: worktreeListItemsModifiedNewestFirst(context.choices),
    multiple: false,
  });
  if (!selected) {
    throw new CliError("No worktree selected.");
  }

  return selected;
}

function switchSource(context: ProjectContext, target: WorktreeChoice): void {
  mkdirSync(context.liveDir, { recursive: true });

  if (existsSync(context.srcLink) && !lstatSync(context.srcLink).isSymbolicLink()) {
    throw new CliError(`Refusing to replace non-symlink path: ${context.srcLink}`);
  }

  if (existsSync(context.srcLink) || isDanglingSymlink(context.srcLink)) {
    unlinkSync(context.srcLink);
  }

  symlinkSync(target.path, context.srcLink, "dir");
  writeFileSync(context.stateFile, `${target.path}\n`, "utf8");
  console.log(`.livetree/src -> ${target.path}`);
  console.log(`Active: ${target.label}`);
}

function listWorktrees(context: ProjectContext): void {
  const active = activeSource(context);
  const items = worktreeListItemsModifiedNewestFirst(context.choices);
  const ageWidth = ageColumnWidth(items);

  for (const item of items) {
    console.log(formatWorktreeListRow(item, active, ageWidth));
    console.log(`    ${dim(item.choice.path)}`);
  }
}

function worktreeListItemsModifiedNewestFirst(choices: WorktreeChoice[]): WorktreeListItem[] {
  return worktreesModifiedNewestFirst(choices).map((item) => ({
    ...item,
    searchText: worktreeSearchText(item.choice),
  }));
}

function worktreesModifiedNewestFirst(choices: WorktreeChoice[]): ModifiedWorktreeChoice[] {
  return choices
    .map((choice) => ({ choice, modifiedAtMs: worktreeModifiedAtMs(choice) }))
    .sort((left, right) => {
      if (right.modifiedAtMs !== left.modifiedAtMs) {
        return right.modifiedAtMs - left.modifiedAtMs;
      }

      return left.choice.path.localeCompare(right.choice.path);
    });
}

function worktreeModifiedAtMs(choice: WorktreeChoice): number {
  const rootModifiedAt = pathModifiedAtMs(choice.path);
  const dirtyModifiedAt = worktreeDirtyModifiedAtMs(choice.path);
  const commitModifiedAt = worktreeLastCommitAtMs(choice.path);
  return maxPositiveNumber(rootModifiedAt, dirtyModifiedAt, commitModifiedAt) ?? Number.NEGATIVE_INFINITY;
}

function worktreeDirtyModifiedAtMs(worktreePath: string): number | null {
  let output: string;
  try {
    output = execFileSync("git", ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  const modifiedTimes = parsePorcelainPaths(output)
    .map((relativePath) => pathModifiedAtMs(path.join(worktreePath, relativePath)))
    .filter((value): value is number => value !== null);

  return maxPositiveNumber(...modifiedTimes);
}

function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  const records = output.split("\0").filter(Boolean);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) {
      continue;
    }

    const status = record.slice(0, 2);
    const firstPath = record.slice(3);
    if (firstPath) {
      paths.push(firstPath);
    }

    if (status.includes("R") || status.includes("C")) {
      const secondPath = records[index + 1];
      if (secondPath) {
        paths.push(secondPath);
        index += 1;
      }
    }
  }

  return paths;
}

function worktreeLastCommitAtMs(worktreePath: string): number | null {
  let output: string;
  try {
    output = execFileSync("git", ["-C", worktreePath, "log", "-1", "--format=%ct"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }

  const seconds = Number.parseInt(output, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function pathModifiedAtMs(value: string): number | null {
  try {
    const stats = lstatSync(value);
    return maxPositiveNumber(stats.mtimeMs, stats.ctimeMs);
  } catch {
    return null;
  }
}

function maxPositiveNumber(...values: Array<number | null | undefined>): number | null {
  let maximum: number | null = null;
  for (const value of values) {
    if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) {
      continue;
    }

    maximum = maximum === null ? value : Math.max(maximum, value);
  }

  return maximum;
}

function formatRelativeAge(modifiedAtMs: number): string {
  if (!Number.isFinite(modifiedAtMs)) {
    return "?";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - modifiedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return "0m";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `${elapsedDays}d`;
  }

  const elapsedWeeks = Math.floor(elapsedDays / 7);
  if (elapsedWeeks < 8) {
    return `${elapsedWeeks}w`;
  }

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) {
    return `${elapsedMonths}mo`;
  }

  return `${Math.floor(elapsedDays / 365)}y`;
}

function dim(value: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return value;
  }

  return `\x1b[2m${value}\x1b[0m`;
}

async function initWorktree(context: ProjectContext): Promise<void> {
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

type LtConfig = {
  initScript: string | null;
  copyFiles: string[];
  runScripts: Record<string, string>;
  configPath: string;
};

type RunOptions = {
  scriptName: string | null;
  scriptArgs: string[];
};

type RunConfiguredScriptOptions = {
  shortcut?: boolean;
};

type LivetreeSourceSnapshot = {
  source: string;
  key: string;
};

type ModifiedWorktreeChoice = {
  choice: WorktreeChoice;
  modifiedAtMs: number;
};

type WorktreeListItem = ModifiedWorktreeChoice & {
  searchText: string;
};

type CreatedWorktreeChoice = {
  choice: WorktreeChoice;
  createdAtMs: number;
};

function uninitializedWorktreesNewestFirst(choices: WorktreeChoice[]): WorktreeChoice[] {
  return worktreesNewestFirst(choices)
    .map((choice) => choice.choice)
    .filter((choice) => !isWorktreeInitialized(choice));
}

function isWorktreeInitialized(choice: WorktreeChoice): boolean {
  const liveDir = path.join(choice.path, ".livetree");
  try {
    const stats = lstatSync(liveDir);
    if (stats.isDirectory()) {
      return true;
    }

    throw new CliError(`Cannot initialize worktree because .livetree exists and is not a directory: ${liveDir}`);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    return false;
  }
}

function markWorktreeInitialized(choice: WorktreeChoice): void {
  const liveDir = path.join(choice.path, ".livetree");
  if (existsSync(liveDir) && !lstatSync(liveDir).isDirectory()) {
    throw new CliError(`Cannot mark worktree initialized because .livetree is not a directory: ${liveDir}`);
  }

  mkdirSync(liveDir, { recursive: true });
  writeFileSync(path.join(liveDir, ".source"), `${choice.path}\n`, "utf8");
}

function worktreesNewestFirst(choices: WorktreeChoice[]): CreatedWorktreeChoice[] {
  return choices
    .map((choice) => ({ choice, createdAtMs: worktreeCreatedAtMs(choice) }))
    .sort((left, right) => {
      if (right.createdAtMs !== left.createdAtMs) {
        return right.createdAtMs - left.createdAtMs;
      }

      return left.choice.path.localeCompare(right.choice.path);
    });
}

function worktreeCreatedAtMs(choice: WorktreeChoice): number {
  try {
    const stats = lstatSync(choice.path);
    return firstPositiveNumber(stats.birthtimeMs, stats.ctimeMs, stats.mtimeMs) ?? Number.NEGATIVE_INFINITY;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function firstPositiveNumber(...values: number[]): number | null {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
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

async function runConfiguredScript(context: ProjectContext, args: string[], watch: boolean, options: RunConfiguredScriptOptions = {}): Promise<void> {
  const command = watch ? "watch" : "run";
  const usageLine = options.shortcut ? "livetree <script-name> [args...]" : `livetree ${command} <script-name> [args...]`;
  const runOptions = parseRunArgs(args, command, usageLine, !options.shortcut);
  const config = readLtConfig(context);

  if (!runOptions.scriptName) {
    throw new CliError(`Usage: ${usageLine}${formatAvailableRunScripts(config)}`);
  }

  const script = config.runScripts[runOptions.scriptName];
  if (!script) {
    if (options.shortcut) {
      throw new CliError(
        `Unknown command or run script '${runOptions.scriptName}'. To switch worktrees, use 'livetree switch ${args.join(" ")}'.${formatAvailableRunScripts(config)}`,
      );
    }

    throw new CliError(`No run script named '${runOptions.scriptName}' in ${config.configPath}.${formatAvailableRunScripts(config)}`);
  }

  if (watch) {
    await runWatchedScript(context, runOptions.scriptName, script, runOptions.scriptArgs);
  } else {
    runScriptOnce(context, runOptions.scriptName, script, runOptions.scriptArgs);
  }
}

function parseRunArgs(args: string[], command: "run" | "watch", usageLine: string, allowStaticOption: boolean): RunOptions {
  let scriptName: string | null = null;
  const scriptArgs: string[] = [];

  for (const arg of args) {
    if (!scriptName) {
      if (allowStaticOption && command === "run" && arg === "--static") {
        continue;
      }

      if (arg.startsWith("-")) {
        throw new CliError(`Unknown option: ${arg}\n\nUsage: ${usageLine}`);
      }

      scriptName = arg;
      continue;
    }

    scriptArgs.push(arg);
  }

  if (!scriptName) {
    return {
      scriptName: null,
      scriptArgs,
    };
  }

  return {
    scriptName,
    scriptArgs,
  };
}

function formatAvailableRunScripts(config: LtConfig): string {
  const names = Object.keys(config.runScripts).sort();
  if (names.length === 0) {
    return `\n\nNo run scripts are defined in ${config.configPath}. Add one like:\nrun:\n  web: cd src/modules/web && pnpm start`;
  }

  return `\n\nAvailable run scripts:\n${names.map((name) => `  ${name}`).join("\n")}`;
}

function scriptWithArgs(script: string, args: string[]): string {
  if (args.length === 0) {
    return script;
  }

  return `${script} ${args.map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string {
  if (value === "") {
    return "''";
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runScriptOnce(context: ProjectContext, scriptName: string, script: string, scriptArgs: string[]): void {
  const snapshot = requireRunnableLivetreeSource(context);
  const result = spawnSync(scriptWithArgs(script, scriptArgs), {
    cwd: context.liveDir,
    env: runScriptEnv(context, scriptName, snapshot.source),
    shell: true,
    stdio: "inherit",
  });

  assertRunResult(result, scriptName);
}

async function runWatchedScript(context: ProjectContext, scriptName: string, script: string, scriptArgs: string[]): Promise<void> {
  mkdirSync(context.liveDir, { recursive: true });
  let current = requireRunnableLivetreeSource(context);
  let child: ChildProcess | null = null;
  let stoppingChild: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  let missingLogged = false;
  let poll: NodeJS.Timeout | null = null;

  console.error(`lt watch ${scriptName}: watching ${context.srcLink}`);

  const start = (snapshot: LivetreeSourceSnapshot): void => {
    current = snapshot;
    missingLogged = false;
    console.error(`lt watch ${scriptName}: starting for ${snapshot.source}`);
    const startedChild = spawn(scriptWithArgs(script, scriptArgs), {
      cwd: context.liveDir,
      env: runScriptEnv(context, scriptName, snapshot.source),
      shell: true,
      stdio: "inherit",
    });
    child = startedChild;

    startedChild.on("error", (error) => {
      if (!shuttingDown) {
        cleanup();
        rejectRun(new CliError(`Run script '${scriptName}' failed to start: ${error.message}`));
      }
    });

    startedChild.on("exit", (code, signal) => {
      if (startedChild === stoppingChild || startedChild !== child || restarting || shuttingDown) {
        return;
      }

      cleanup();
      if (signal) {
        rejectRun(new CliError(signal === "SIGINT" ? "Canceled." : `Run script '${scriptName}' terminated by signal ${signal}.`, signalExitCode(signal)));
        return;
      }

      if (code && code !== 0) {
        rejectRun(new CliError(`Run script '${scriptName}' exited with status ${code}.`, code));
        return;
      }

      resolveRun();
    });
  };

  let resolveRun: () => void = () => undefined;
  let rejectRun: (error: CliError) => void = () => undefined;

  const cleanup = (): void => {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };

  const restart = async (next: LivetreeSourceSnapshot | null): Promise<void> => {
    if (restarting || shuttingDown) {
      return;
    }

    restarting = true;
    const previous = child;
    child = null;

    if (previous) {
      stoppingChild = previous;
      stopChildProcess(previous, "SIGTERM");
      await waitForChildToExit(previous, 5000);
      stoppingChild = null;
    }

    restarting = false;

    if (shuttingDown) {
      return;
    }

    if (next) {
      start(next);
      return;
    }

    if (!missingLogged) {
      console.error(`lt watch ${scriptName}: waiting for ${context.srcLink}`);
      missingLogged = true;
    }
  };

  const checkForChange = (): void => {
    let next: LivetreeSourceSnapshot | null;
    try {
      next = readRunnableLivetreeSource(context);
    } catch (error) {
      cleanup();
      rejectRun(error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error)));
      return;
    }

    if (!next) {
      void restart(null);
      return;
    }

    if (!child || next.key !== current.key) {
      console.error(`lt watch ${scriptName}: live tree changed`);
      void restart(next);
    }
  };

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    cleanup();
    const previous = child;
    child = null;
    if (previous) {
      stopChildProcess(previous, signal);
      await waitForChildToExit(previous, 5000);
    }

    rejectRun(new CliError(signal === "SIGINT" ? "Canceled." : `Run script '${scriptName}' terminated by signal ${signal}.`, signalExitCode(signal)));
  };

  const onSigint = (): void => {
    void shutdown("SIGINT");
  };

  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };

  return new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    start(current);
    poll = setInterval(checkForChange, 1000);
  });
}

function runScriptEnv(context: ProjectContext, scriptName: string, activeSourcePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LT_ACTIVE_WORKTREE: activeSourcePath,
    LT_LIVE_DIR: context.liveDir,
    LT_LIVE_SRC: context.srcLink,
    LT_PROJECT_ROOT: context.mainRoot,
    LT_SCRIPT: scriptName,
  };
}

function assertRunResult(result: SpawnSyncReturns<Buffer>, scriptName: string): void {
  if (result.error) {
    throw new CliError(`Run script '${scriptName}' failed to start: ${result.error.message}`);
  }

  if (result.signal) {
    throw new CliError(result.signal === "SIGINT" ? "Canceled." : `Run script '${scriptName}' terminated by signal ${result.signal}.`, signalExitCode(result.signal));
  }

  if (result.status && result.status !== 0) {
    throw new CliError(`Run script '${scriptName}' exited with status ${result.status}.`, result.status);
  }
}

function requireRunnableLivetreeSource(context: ProjectContext): LivetreeSourceSnapshot {
  const snapshot = readRunnableLivetreeSource(context);
  if (!snapshot) {
    throw new CliError(`No active .livetree/src target. Run 'lt' to select a worktree first.`);
  }

  return snapshot;
}

function readRunnableLivetreeSource(context: ProjectContext): LivetreeSourceSnapshot | null {
  if (existsSync(context.srcLink) && !lstatSync(context.srcLink).isSymbolicLink()) {
    throw new CliError(`Refusing to run with non-symlink path: ${context.srcLink}`);
  }

  if (!isDanglingSymlink(context.srcLink) && !existsSync(context.srcLink)) {
    return null;
  }

  const source = activeSourceFrom(context.liveDir, context.srcLink, context.stateFile);
  if (!source || !existsSync(source)) {
    return null;
  }

  return {
    source,
    key: normalizePath(source),
  };
}

function stopChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  stopProcessTree(child.pid, signal);
}

function stopProcessTree(pid: number, signal: NodeJS.Signals): void {
  for (const childPid of childProcessIds(pid)) {
    stopProcessTree(childPid, signal);
  }

  try {
    process.kill(pid, signal);
  } catch {
    // The process already exited.
  }
}

function childProcessIds(pid: number): number[] {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const output = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!output) {
      return [];
    }

    return output
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function waitForChildToExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      stopChildProcess(child, "SIGKILL");
    }, timeoutMs);
    const giveUp = setTimeout(resolve, timeoutMs + 1000);

    child.once("exit", () => {
      clearTimeout(timeout);
      clearTimeout(giveUp);
      resolve();
    });
  });
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  return 1;
}

function readLtConfig(context: ProjectContext): LtConfig {
  const configPath = path.join(context.mainRoot, ".ltconf");
  if (!existsSync(configPath)) {
    throw new CliError(`No .ltconf found at ${configPath}.\n\nAdd one like:\ninit:\n  script: pnpm install\nrun:\n  web: cd src/modules/web && pnpm start`);
  }

  const config = parseLtConfig(readFileSync(configPath, "utf8"));
  return {
    configPath,
    initScript: config.initScript,
    copyFiles: normalizeCopyFilePaths(config.copyFiles),
    runScripts: normalizeRunScripts(config.runScripts),
  };
}

type ParsedLtConfig = {
  initScript: string | null;
  copyFiles: string[];
  runScripts: Record<string, string>;
};

type YamlRecord = Record<string, unknown>;

function parseLtConfig(source: string): ParsedLtConfig {
  const parsed = parseLtConfigYaml(source);
  let initScript: string | null = null;
  let copyFiles: string[] = [];
  let runScripts: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (key === "initScript" || key === "initCommand") {
      initScript = yamlScalarString(value);
      continue;
    }

    if (key === "init") {
      const scalarValue = yamlScalarString(value);
      if (scalarValue) {
        initScript = scalarValue;
        continue;
      }

      if (isYamlRecord(value)) {
        initScript = yamlFirstScalarString(value, ["script", "command", "run"]);
        copyFiles = yamlFirstStringList(value, ["copy", "copyFiles", "files"]);
      } else {
        initScript = null;
        copyFiles = [];
      }
      continue;
    }

    if (key === "scripts") {
      initScript = isYamlRecord(value) ? yamlScalarString(value.init) : null;
      continue;
    }

    if (key === "run") {
      runScripts = isYamlRecord(value) ? yamlStringMap(value) : {};
    }
  }

  return {
    initScript,
    copyFiles,
    runScripts,
  };
}

function parseLtConfigYaml(source: string): YamlRecord {
  let parsed: unknown;
  try {
    parsed = parseYaml(source) ?? {};
  } catch (error) {
    throw new CliError(`Invalid .ltconf YAML: ${errorMessage(error)}`);
  }

  if (!isYamlRecord(parsed)) {
    throw new CliError(".ltconf must contain a YAML mapping.");
  }

  return parsed;
}

function yamlFirstScalarString(record: YamlRecord, keys: string[]): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key)) {
      return yamlScalarString(value);
    }
  }

  return null;
}

function yamlFirstStringList(record: YamlRecord, keys: string[]): string[] {
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key)) {
      return yamlStringList(value);
    }
  }

  return [];
}

function yamlStringMap(record: YamlRecord): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(record)) {
    const scalarValue = yamlScalarString(value);
    if (scalarValue) {
      values[key] = scalarValue;
    }
  }

  return values;
}

function yamlStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const scalarValue = yamlScalarString(item);
      return scalarValue ? [scalarValue] : [];
    });
  }

  const scalarValue = yamlScalarString(value);
  return scalarValue ? [scalarValue] : [];
}

function yamlScalarString(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() ? value : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function isYamlRecord(value: unknown): value is YamlRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCopyFilePaths(paths: string[]): string[] {
  return paths.map((value) => {
    const trimmed = value.trim();
    const normalized = path.normalize(trimmed);

    if (!trimmed || path.isAbsolute(trimmed) || normalized === "." || normalized.split(path.sep).includes("..")) {
      throw new CliError(`Init copy paths must be relative files inside the project: ${value}`);
    }

    return normalized;
  });
}

function normalizeRunScripts(scripts: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [name, script] of Object.entries(scripts)) {
    const trimmedName = name.trim();
    const trimmedScript = script.trim();
    if (!trimmedName || !/^[A-Za-z0-9_-]+$/.test(trimmedName)) {
      throw new CliError(`Run script names must use letters, numbers, underscores, or hyphens: ${name}`);
    }

    if (!trimmedScript) {
      throw new CliError(`Run script '${trimmedName}' must not be empty.`);
    }

    normalized[trimmedName] = trimmedScript;
  }

  return normalized;
}

async function removeWorktrees(context: ProjectContext): Promise<void> {
  const candidates = context.choices.filter((choice) => !choice.isMain);
  const active = activeSource(context);

  if (candidates.length === 0) {
    throw new CliError("No removable worktrees found. ROOT cannot be removed by livetree.");
  }

  if (!process.stdin.isTTY) {
    throw new CliError(`Choose worktrees to remove from an interactive terminal:\n${formatNumberedChoiceList(candidates, active)}`);
  }

  const selected = await selectWorktreesToRemove(candidates, active);
  if (selected.length === 0) {
    throw new CliError("No worktrees selected.");
  }

  const confirmed = await confirmRemoveWorktrees(selected, active);
  if (!confirmed) {
    throw new CliError("Canceled.");
  }

  const removed: WorktreeChoice[] = [];
  for (const choice of selected) {
    const didRemove = await removeGitWorktreeWithForcePrompt(context, choice);
    if (didRemove) {
      removed.push(choice);
      console.log(`Removed: ${choice.label}`);
    }
  }

  const clearedSources = clearRemovedActiveSources(context, removed);
  for (const sourceName of clearedSources) {
    console.log(`Cleared ${sourceName} because it pointed at a removed worktree.`);
  }
}

async function selectWorktreesToRemove(choices: WorktreeChoice[], active: string | null): Promise<WorktreeChoice[]> {
  return selectFromInteractiveWorktreeList({
    active,
    items: worktreeListItemsModifiedNewestFirst(choices),
    multiple: true,
  });
}

async function confirmRemoveWorktrees(choices: WorktreeChoice[], active: string | null): Promise<boolean> {
  process.stderr.write("\nThe following worktrees will be removed:\n");
  const items = worktreeListItemsModifiedNewestFirst(choices);
  const ageWidth = ageColumnWidth(items);
  for (const item of items) {
    process.stderr.write(`  ${formatWorktreeListRow(item, active, ageWidth)}\n`);
    process.stderr.write(`    ${item.choice.path}\n`);
  }

  const answer = await askQuestion(`\nRemove ${choices.length} worktree${choices.length === 1 ? "" : "s"}? [y/n] `);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

async function confirmForceRemoveWorktree(choice: WorktreeChoice): Promise<boolean> {
  const answer = await askQuestion(`Force remove ${choice.label} and delete all changes in that worktree? [y/n] `);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

async function confirmDeletePrunableWorktreeDirectory(choice: WorktreeChoice): Promise<boolean> {
  const answer = await askQuestion(`Delete leftover directory for ${choice.label}? [y/n] `);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function removeGitWorktreeWithForcePrompt(context: ProjectContext, choice: WorktreeChoice): Promise<boolean> {
  try {
    if (choice.prunable) {
      throw new WorktreeRemovePrunableError(`Git marks ${choice.label} as prunable: ${choice.prunable}`);
    }

    removeGitWorktree(context, choice, false);
    return true;
  } catch (error) {
    if (error instanceof WorktreeRemovePrunableError) {
      return removePrunableWorktree(context, choice, error.message);
    }

    if (!(error instanceof WorktreeRemoveNeedsForceError)) {
      throw error;
    }

    process.stderr.write(`${error.message}\n`);
    const confirmed = await confirmForceRemoveWorktree(choice);
    if (!confirmed) {
      console.log(`Skipped: ${choice.label}`);
      return false;
    }

    removeGitWorktree(context, choice, true);
    return true;
  }
}

async function removePrunableWorktree(context: ProjectContext, choice: WorktreeChoice, reason: string): Promise<boolean> {
  process.stderr.write(`${reason}\n`);
  pruneGitWorktrees(context);

  if (!existsSync(choice.path)) {
    console.log(`Pruned stale worktree metadata: ${choice.label}`);
    return true;
  }

  const gitFile = path.join(choice.path, ".git");
  if (existsSync(gitFile)) {
    console.log(`Pruned stale worktree metadata: ${choice.label}`);
    console.log(`Left directory in place because it now contains a .git file: ${choice.path}`);
    return true;
  }

  const confirmed = await confirmDeletePrunableWorktreeDirectory(choice);
  if (!confirmed) {
    console.log(`Pruned stale worktree metadata: ${choice.label}`);
    console.log(`Left directory in place: ${choice.path}`);
    return true;
  }

  rmSync(choice.path, { recursive: true, force: true });
  console.log(`Deleted leftover directory: ${choice.path}`);
  return true;
}

function pruneGitWorktrees(context: ProjectContext): void {
  try {
    execFileSync("git", ["worktree", "prune", "--expire", "now"], {
      cwd: context.mainRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CliError(formatGitFailure(error, "git worktree prune --expire now"));
  }
}

function removeGitWorktree(context: ProjectContext, choice: WorktreeChoice, force: boolean): void {
  const args = force ? ["worktree", "remove", "--force", choice.path] : ["worktree", "remove", choice.path];
  try {
    execFileSync("git", args, {
      cwd: context.mainRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = formatGitFailure(error, `git ${args.join(" ")}`);
    if (!force && isWorktreeNeedsForceError(error)) {
      throw new WorktreeRemoveNeedsForceError(message);
    }

    if (!force && isWorktreePrunableError(error)) {
      throw new WorktreeRemovePrunableError(message);
    }

    throw new CliError(message);
  }
}

function isWorktreeNeedsForceError(error: unknown): boolean {
  const output = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  return output.includes("contains modified or untracked files") && output.includes("--force");
}

function isWorktreePrunableError(error: unknown): boolean {
  const output = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  return output.includes("validation failed, cannot remove working tree") && output.includes(".git") && output.includes("does not exist");
}

function formatGitFailure(error: unknown, command: string): string {
  const output = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
  return output ? `${command} failed:\n${output}` : `${command} failed.`;
}

function clearRemovedActiveSources(context: ProjectContext, removed: WorktreeChoice[]): string[] {
  return [
    clearRemovedActiveSource(".livetree/src", context.liveDir, context.srcLink, context.stateFile, removed),
  ].filter((sourceName): sourceName is string => sourceName !== null);
}

function clearRemovedActiveSource(
  sourceName: string,
  liveDir: string,
  srcLink: string,
  stateFile: string,
  removed: WorktreeChoice[],
): string | null {
  const source = activeSourceFrom(liveDir, srcLink, stateFile);
  if (!source || !removed.some((choice) => samePath(choice.path, source))) {
    return null;
  }

  if (isDanglingSymlink(srcLink) || (existsSync(srcLink) && lstatSync(srcLink).isSymbolicLink())) {
    unlinkSync(srcLink);
  }

  if (existsSync(stateFile)) {
    unlinkSync(stateFile);
  }

  return sourceName;
}

function activeSource(context: ProjectContext): string | null {
  return activeSourceFrom(context.liveDir, context.srcLink, context.stateFile);
}

function activeSourceFrom(liveDir: string, srcLink: string, stateFile: string): string | null {
  if (isDanglingSymlink(srcLink) || (existsSync(srcLink) && lstatSync(srcLink).isSymbolicLink())) {
    const link = readlinkSync(srcLink);
    return path.isAbsolute(link) ? link : path.resolve(liveDir, link);
  }

  if (!existsSync(stateFile)) {
    return null;
  }

  return readFileSync(stateFile, "utf8").split(/\r?\n/, 1)[0]?.trim() || null;
}

function gitCommonDir(root: string): string {
  const common = git(["rev-parse", "--git-common-dir"], root);
  return path.isAbsolute(common) ? common : path.resolve(root, common);
}

function git(args: string[], cwd: string, errorMessage?: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch {
    throw new CliError(errorMessage ?? `Git command failed: git ${args.join(" ")}`);
  }
}

function codexChatForPath(worktreePath: string): CodexChat | null {
  const byPath = queryCodexCatalog(`select display_title, thread_id
from local_thread_catalog
where missing_candidate = 0
  and cwd = ${sqlQuote(worktreePath)}
order by source_updated_at desc
limit 1;`);

  if (byPath) {
    return byPath;
  }

  const threadId = threadIdForPath(worktreePath);
  if (!threadId) {
    return null;
  }

  return queryCodexCatalog(`select display_title, thread_id
from local_thread_catalog
where missing_candidate = 0
  and thread_id = ${sqlQuote(threadId)}
order by source_updated_at desc
limit 1;`);
}

function queryCodexCatalog(sql: string): CodexChat | null {
  const db = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sqlite", "codex-dev.db");
  if (!existsSync(db)) {
    return null;
  }

  try {
    const output = execFileSync("sqlite3", ["-separator", "\t", db, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!output) {
      return null;
    }

    const [title, threadId] = output.split("\t");
    if (!title && !threadId) {
      return null;
    }

    return {
      title: title ?? "",
      threadId: threadId ?? "",
    };
  } catch {
    return null;
  }
}

function threadIdForPath(worktreePath: string): string | null {
  return readGitdirJsonValue(worktreePath, "codex-thread.json", "ownerThreadId");
}

function syncedBranchForPath(worktreePath: string): string | null {
  const branch = readGitdirJsonValue(worktreePath, "codex-synced-branch.json", "branch");
  return branch ? stripHeadsPrefix(branch) : null;
}

function readGitdirJsonValue(worktreePath: string, filename: string, key: string): string | null {
  let gitdir: string;
  try {
    gitdir = git(["rev-parse", "--git-dir"], worktreePath);
  } catch {
    return null;
  }

  const absoluteGitdir = path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreePath, gitdir);
  const file = path.join(absoluteGitdir, filename);
  if (!existsSync(file)) {
    return null;
  }

  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const value = json[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function resolveExistingPath(value: string, cwd: string): string | null {
  const candidate = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  if (!existsSync(candidate)) {
    return null;
  }

  return normalizePath(candidate);
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isDanglingSymlink(value: string): boolean {
  try {
    return lstatSync(value).isSymbolicLink();
  } catch {
    return false;
  }
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function stripHeadsPrefix(value: string): string {
  return value.replace(/^refs\/heads\//, "");
}

function writeInlineBlock(lines: string[], previousLineCount: number): void {
  if (previousLineCount > 0) {
    readline.moveCursor(process.stderr, 0, -previousLineCount);
  }

  const linesToClear = Math.max(previousLineCount, lines.length);
  for (let index = 0; index < linesToClear; index += 1) {
    const line = lines[index] ?? "";
    readline.clearLine(process.stderr, 0);
    readline.cursorTo(process.stderr, 0);
    process.stderr.write(`${line}\n`);
  }

  if (previousLineCount > lines.length) {
    readline.moveCursor(process.stderr, 0, lines.length - previousLineCount);
  }
}

function formatChoiceLabel(choice: WorktreeChoice, active: string | null): string {
  const marker = active && samePath(choice.path, active) ? "*" : " ";
  return `${marker} ${choice.label}`;
}

function formatChoiceList(choices: WorktreeChoice[], active: string | null): string {
  const items = worktreeListItemsModifiedNewestFirst(choices);
  const ageWidth = ageColumnWidth(items);
  return items.map((item) => `  ${formatWorktreeListRow(item, active, ageWidth)}`).join("\n");
}

function formatNumberedChoiceList(choices: WorktreeChoice[], active: string | null): string {
  const items = worktreeListItemsModifiedNewestFirst(choices);
  const ageWidth = ageColumnWidth(items);
  const numberWidth = Math.max(String(items.length).length, 1);
  return items.map((item, index) => `  ${String(index + 1).padStart(numberWidth)}. ${formatWorktreeListRow(item, active, ageWidth)}`).join("\n");
}

type InteractiveWorktreeListOptions = {
  active: string | null;
  items: WorktreeListItem[];
  multiple: boolean;
};

function selectFromInteractiveWorktreeList(options: InteractiveWorktreeListOptions): Promise<WorktreeChoice[]> {
  const { active, items, multiple } = options;
  let query = "";
  let selectedIndex = Math.max(0, items.findIndex((item) => active && samePath(item.choice.path, active)));
  const checkedPaths = new Set<string>();
  const ageWidth = ageColumnWidth(items);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let renderedLines = 0;

    const cleanup = (): void => {
      stdin.off("keypress", onKeypress);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const filteredItems = (): WorktreeListItem[] => filterWorktreeListItems(items, query);

    const clampSelection = (filteredLength: number): void => {
      if (filteredLength === 0) {
        selectedIndex = 0;
      } else if (selectedIndex >= filteredLength) {
        selectedIndex = filteredLength - 1;
      } else if (selectedIndex < 0) {
        selectedIndex = 0;
      }
    };

    const render = (): void => {
      const filtered = filteredItems();
      clampSelection(filtered.length);
      const lines = formatInteractiveWorktreeList({
        active,
        ageWidth,
        checkedPaths,
        filtered,
        items,
        multiple,
        query,
        selectedIndex,
      });

      writeInlineBlock(lines, renderedLines);
      renderedLines = lines.length;
    };

    const finish = (): void => {
      const filtered = filteredItems();
      clampSelection(filtered.length);
      if (!multiple && filtered.length === 0) {
        render();
        return;
      }

      cleanup();
      if (multiple) {
        resolve(items.filter((item) => checkedPaths.has(item.choice.path)).map((item) => item.choice));
        return;
      }

      resolve([filtered[selectedIndex]!.choice]);
    };

    const cancel = (): void => {
      cleanup();
      process.stderr.write("Canceled.\n");
      reject(new CliError("Canceled."));
    };

    const moveSelection = (delta: number): void => {
      const filtered = filteredItems();
      if (filtered.length === 0) {
        render();
        return;
      }

      selectedIndex = (selectedIndex + delta + filtered.length) % filtered.length;
      render();
    };

    const resetQuerySelection = (): void => {
      selectedIndex = 0;
      render();
    };

    const toggleSelected = (): void => {
      if (!multiple) {
        return;
      }

      const filtered = filteredItems();
      clampSelection(filtered.length);
      const item = filtered[selectedIndex];
      if (!item) {
        render();
        return;
      }

      if (checkedPaths.has(item.choice.path)) {
        checkedPaths.delete(item.choice.path);
      } else {
        checkedPaths.add(item.choice.path);
      }
      render();
    };

    const onKeypress = (value: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }

      switch (key.name ?? value) {
        case "return":
        case "enter":
          finish();
          return;
        case "escape":
          if (query.length > 0) {
            query = "";
            resetQuerySelection();
          } else {
            cancel();
          }
          return;
        case "backspace":
          if (query.length > 0) {
            query = dropLastCharacter(query);
            resetQuerySelection();
          }
          return;
        case "up":
          moveSelection(-1);
          return;
        case "down":
          moveSelection(1);
          return;
        case "tab":
          toggleSelected();
          return;
        case "space":
          if (multiple) {
            toggleSelected();
            return;
          }
          break;
        default:
          break;
      }

      const typed = printableKeypressValue(value, key);
      if (typed !== null) {
        query += typed;
        resetQuerySelection();
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

type InteractiveWorktreeListRenderOptions = {
  active: string | null;
  ageWidth: number;
  checkedPaths: Set<string>;
  filtered: WorktreeListItem[];
  items: WorktreeListItem[];
  multiple: boolean;
  query: string;
  selectedIndex: number;
};

function formatInteractiveWorktreeList(options: InteractiveWorktreeListRenderOptions): string[] {
  const { active, ageWidth, checkedPaths, filtered, items, multiple, query, selectedIndex } = options;
  const lines = [formatSearchBox(query, selectedIndex, filtered.length, items.length, multiple ? checkedPaths.size : null)];

  if (filtered.length === 0) {
    lines.push("  No matches");
    return lines;
  }

  const [start, end] = visibleWorktreePickerRange(filtered.length, selectedIndex);
  for (let index = start; index < end; index += 1) {
    const item = filtered[index]!;
    const checkbox = multiple ? `${checkedPaths.has(item.choice.path) ? "[x]" : "[ ]"} ` : "";
    const line = `${index === selectedIndex ? "> " : "  "}${checkbox}${formatWorktreeListRow(item, active, ageWidth)}`;
    lines.push(index === selectedIndex ? reverse(line) : line);
  }

  return lines;
}

function filterWorktreeListItems(items: WorktreeListItem[], query: string): WorktreeListItem[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return items;
  }

  return fuzzysort.go(trimmed, items, { key: "searchText" }).map((result) => result.obj);
}

function visibleWorktreePickerRange(itemCount: number, selectedIndex: number): [number, number] {
  const terminalRows = process.stderr.rows;
  const maxVisible = Math.max(1, Math.min(itemCount, typeof terminalRows === "number" && terminalRows > 1 ? terminalRows - 1 : itemCount));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), itemCount - maxVisible));
  return [start, start + maxVisible];
}

function formatSearchBox(query: string, selectedIndex: number, filteredCount: number, totalCount: number, checkedCount: number | null): string {
  const selectedNumber = filteredCount === 0 ? 0 : selectedIndex + 1;
  const count = filteredCount === totalCount ? `${selectedNumber}/${filteredCount}` : `${selectedNumber}/${filteredCount} of ${totalCount}`;
  const checked = checkedCount === null ? "" : `, ${checkedCount} selected`;
  return `Search: [${escapeControlCharacters(query)}] ${count}${checked}`;
}

function formatWorktreeListRow(item: WorktreeListItem, active: string | null, ageWidth: number): string {
  return `${formatRelativeAge(item.modifiedAtMs).padStart(ageWidth)}  ${formatChoiceLabel(item.choice, active)}`;
}

function ageColumnWidth(items: WorktreeListItem[]): number {
  return Math.max(...items.map((item) => formatRelativeAge(item.modifiedAtMs).length), 1);
}

function worktreeSearchText(choice: WorktreeChoice): string {
  return [
    choice.label,
    choice.path,
    path.basename(choice.path),
    choice.ref,
    choice.branch,
    choice.head,
    choice.chat?.title,
    choice.chat?.threadId,
  ].filter((value): value is string => Boolean(value)).join(" ");
}

function printableKeypressValue(value: string, key: readline.Key): string | null {
  if (key.ctrl || key.meta || value.length === 0) {
    return null;
  }

  return /^[^\x00-\x1F\x7F]+$/.test(value) ? value : null;
}

function dropLastCharacter(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

function escapeControlCharacters(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "");
}

function reverse(value: string): string {
  if (!process.stderr.isTTY || process.env.NO_COLOR) {
    return value;
  }

  return `\x1b[7m${value}\x1b[0m`;
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    if (error.message !== "Canceled.") {
      console.error(error.message);
    }
    process.exit(error.exitCode);
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
