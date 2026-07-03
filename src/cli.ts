#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

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
  legacyLiveDir: string;
  legacySrcLink: string;
  legacyStateFile: string;
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
  treeswitch
  treeswitch <selector>
  treeswitch init
  treeswitch rm
  treeswitch remove
  treeswitch delete

Selectors can be a branch name, worktree directory name, commit prefix, path,
Codex thread id prefix, or Codex chat title fragment.`;

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
      throw new CliError("Usage: treeswitch init");
    }

    await initWorktree(context);
    return;
  }

  if (["rm", "remove", "delete"].includes(args[0] ?? "")) {
    if (args.length > 1) {
      throw new CliError("Usage: treeswitch rm");
    }

    await removeWorktrees(context);
    return;
  }

  const selector = args.join(" ").trim();
  const target = selector ? resolveSelector(context, selector) : await selectWorktree(context);
  switchSource(context, target);
}

function buildProjectContext(cwd: string): ProjectContext {
  const currentRoot = git(["rev-parse", "--show-toplevel"], cwd, "treeswitch must be run inside a Git worktree.");
  const commonDir = gitCommonDir(currentRoot);
  const records = parseWorktreeList(git(["--git-dir", commonDir, "worktree", "list", "--porcelain"], currentRoot));
  const worktrees = records.filter((record) => !record.bare);
  const mainRoot = worktrees[0]?.path;

  if (!mainRoot) {
    throw new CliError("No non-bare worktrees found for this project.");
  }

  const liveDir = path.join(mainRoot, ".live-tree");
  const srcLink = path.join(liveDir, "src");
  const stateFile = path.join(liveDir, ".source");
  const legacyLiveDir = path.join(mainRoot, "live-tree");
  const legacySrcLink = path.join(legacyLiveDir, "src");
  const legacyStateFile = path.join(legacyLiveDir, ".source");
  const choices = worktrees.map((record, index) => enrichWorktree(record, index === 0));

  return {
    cwd,
    currentRoot,
    commonDir,
    mainRoot,
    liveDir,
    srcLink,
    stateFile,
    legacyLiveDir,
    legacySrcLink,
    legacyStateFile,
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
    throw new CliError(`Choose a worktree by passing one of these selectors:\n${formatNumberedChoiceList(context.choices, active)}`);
  }

  let selected = Math.max(0, context.choices.findIndex((choice) => active && samePath(choice.path, active)));

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

    const render = (): void => {
      const lines = [
        "Select the worktree for .live-tree/src",
        "Use Up/Down, j/k, Enter to choose, q to cancel.",
        "",
      ];

      for (let index = 0; index < context.choices.length; index += 1) {
        const choice = context.choices[index]!;
        const line = formatChoiceLabel(choice, active);
        lines.push(index === selected ? `\x1b[7m> ${line}\x1b[0m` : `  ${line}`);
      }

      if (renderedLines > 0) {
        readline.moveCursor(process.stderr, 0, -renderedLines);
      }

      for (const line of lines) {
        readline.clearLine(process.stderr, 0);
        readline.cursorTo(process.stderr, 0);
        process.stderr.write(`${line}\n`);
      }

      renderedLines = lines.length;
    };

    const finish = (choice: WorktreeChoice): void => {
      cleanup();
      resolve(choice);
    };

    const cancel = (): void => {
      cleanup();
      process.stderr.write("Canceled.\n");
      reject(new CliError("Canceled."));
    };

    const onKeypress = (value: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }

      switch (key.name ?? value) {
        case "return":
        case "enter":
          finish(context.choices[selected]!);
          return;
        case "q":
          cancel();
          return;
        case "up":
        case "k":
          selected = selected > 0 ? selected - 1 : context.choices.length - 1;
          render();
          return;
        case "down":
        case "j":
          selected = (selected + 1) % context.choices.length;
          render();
          return;
        default:
          return;
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
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
  console.log(`.live-tree/src -> ${target.path}`);
  console.log(`Active: ${target.label}`);
}

async function initWorktree(context: ProjectContext): Promise<void> {
  const config = readTswConfig(context);
  const target = await selectInitWorktree(context);
  console.log(`Using init config: ${config.configPath}`);
  copyInitFiles(context, target, config.copyFiles);
  runInitScript(target, config.initScript);
}

type TswConfig = {
  initScript: string;
  copyFiles: string[];
  configPath: string;
};

type CreatedWorktreeChoice = {
  choice: WorktreeChoice;
  createdAtMs: number;
};

async function selectInitWorktree(context: ProjectContext): Promise<WorktreeChoice> {
  const active = activeSource(context);
  const choices = worktreesNewestFirst(context.choices);

  if (!process.stdin.isTTY) {
    throw new CliError(`Choose a worktree to initialize from an interactive terminal:\n${formatNumberedCreatedChoiceList(choices, active)}`);
  }

  let selectedIndex = 0;

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

    const render = (): void => {
      const lines = [
        "Select worktree to initialize",
        "Newest worktrees first. Use Up/Down, j/k, Enter to choose, q to cancel.",
        "",
      ];

      for (let index = 0; index < choices.length; index += 1) {
        const item = choices[index]!;
        const line = formatCreatedChoiceLabel(item, active);
        lines.push(index === selectedIndex ? `\x1b[7m> ${line}\x1b[0m` : `  ${line}`);
      }

      writeInlineBlock(lines, renderedLines);
      renderedLines = lines.length;
    };

    const finish = (): void => {
      cleanup();
      resolve(choices[selectedIndex]!.choice);
    };

    const cancel = (): void => {
      cleanup();
      process.stderr.write("Canceled.\n");
      reject(new CliError("Canceled."));
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
        case "q":
          cancel();
          return;
        case "up":
        case "k":
          selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : choices.length - 1;
          render();
          return;
        case "down":
        case "j":
          selectedIndex = (selectedIndex + 1) % choices.length;
          render();
          return;
        default:
          return;
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
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

function formatNumberedCreatedChoiceList(choices: CreatedWorktreeChoice[], active: string | null): string {
  return choices.map((choice, index) => `  ${index + 1}. ${formatCreatedChoiceLabel(choice, active)}`).join("\n");
}

function formatCreatedChoiceLabel(choice: CreatedWorktreeChoice, active: string | null): string {
  return `${formatChoiceLabel(choice.choice, active)}  ${formatCreatedAt(choice.createdAtMs)}  ${choice.choice.path}`;
}

function formatCreatedAt(createdAtMs: number): string {
  if (!Number.isFinite(createdAtMs)) {
    return "created unknown";
  }

  const value = new Date(createdAtMs);
  return `created ${value.toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  })}`;
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

function readTswConfig(context: ProjectContext): TswConfig {
  const configPath = path.join(context.mainRoot, ".tswconf");
  if (!existsSync(configPath)) {
    throw new CliError(`No .tswconf found at ${configPath}.\n\nAdd one like:\ninit:\n  script: pnpm install`);
  }

  const config = parseTswConfig(readFileSync(configPath, "utf8"));
  if (!config.initScript) {
    throw new CliError(
      `.tswconf must define an init script.\n\nSupported examples:\ninit:\n  copy:\n    - modules/api/.env\n  script: pnpm install\n\ninit:\n  script: |\n    corepack enable\n    pnpm install`,
    );
  }

  return {
    configPath,
    initScript: config.initScript,
    copyFiles: normalizeCopyFilePaths(config.copyFiles),
  };
}

type YamlKeyLine = {
  indent: number;
  key: string;
  value: string;
};

type ParsedTswConfig = {
  initScript: string | null;
  copyFiles: string[];
};

function parseTswConfig(source: string): ParsedTswConfig {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let initScript: string | null = null;
  let copyFiles: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseYamlKeyLine(lines[index]!);
    if (!parsed || parsed.indent !== 0) {
      continue;
    }

    if (parsed.key === "initScript" || parsed.key === "initCommand") {
      initScript = yamlValue(lines, index, parsed);
      continue;
    }

    if (parsed.key === "init") {
      const value = yamlValue(lines, index, parsed);
      if (value) {
        initScript = value;
        continue;
      }

      initScript = nestedYamlValue(lines, index, parsed.indent, ["script", "command", "run"]);
      copyFiles = nestedYamlList(lines, index, parsed.indent, ["copy", "copyFiles", "files"]);
      continue;
    }

    if (parsed.key === "scripts") {
      initScript = nestedYamlValue(lines, index, parsed.indent, ["init"]);
    }
  }

  return {
    initScript,
    copyFiles,
  };
}

function nestedYamlValue(lines: string[], parentIndex: number, parentIndent: number, keys: string[]): string | null {
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const parsed = parseYamlKeyLine(lines[index]!);
    if (!parsed) {
      continue;
    }

    if (parsed.indent <= parentIndent) {
      return null;
    }

    if (keys.includes(parsed.key)) {
      return yamlValue(lines, index, parsed);
    }
  }

  return null;
}

function nestedYamlList(lines: string[], parentIndex: number, parentIndent: number, keys: string[]): string[] {
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const parsed = parseYamlKeyLine(lines[index]!);
    if (!parsed) {
      continue;
    }

    if (parsed.indent <= parentIndent) {
      return [];
    }

    if (keys.includes(parsed.key)) {
      return yamlListValue(lines, index, parsed);
    }
  }

  return [];
}

function yamlValue(lines: string[], index: number, parsed: YamlKeyLine): string | null {
  if (parsed.value === "|" || parsed.value === ">") {
    const block = readYamlBlock(lines, index, parsed.indent);
    return block.trim() ? block : null;
  }

  const value = unquoteYamlScalar(parsed.value);
  return value.trim() ? value : null;
}

function yamlListValue(lines: string[], index: number, parsed: YamlKeyLine): string[] {
  const scalarValue = yamlValue(lines, index, parsed);
  if (scalarValue) {
    return [scalarValue];
  }

  return readYamlList(lines, index, parsed.indent);
}

function readYamlList(lines: string[], parentIndex: number, parentIndent: number): string[] {
  const values: string[] = [];

  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    const indent = leadingSpaceCount(line);
    if (indent <= parentIndent) {
      break;
    }

    const match = /^\s*-\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const value = unquoteYamlScalar(stripInlineYamlComment(match[1]!).trim());
    if (value) {
      values.push(value);
    }
  }

  return values;
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

function readYamlBlock(lines: string[], parentIndex: number, parentIndent: number): string {
  const blockLines: string[] = [];

  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") {
      blockLines.push(line);
      continue;
    }

    const indent = leadingSpaceCount(line);
    if (indent <= parentIndent) {
      break;
    }

    blockLines.push(line);
  }

  const contentIndent = blockLines
    .filter((line) => line.trim() !== "")
    .map(leadingSpaceCount)
    .reduce((minimum, indent) => Math.min(minimum, indent), Number.POSITIVE_INFINITY);

  if (!Number.isFinite(contentIndent)) {
    return "";
  }

  return blockLines.map((line) => (line.trim() === "" ? "" : line.slice(contentIndent))).join("\n").trimEnd();
}

function parseYamlKeyLine(line: string): YamlKeyLine | null {
  if (line.trim() === "" || line.trimStart().startsWith("#")) {
    return null;
  }

  const match = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
  if (!match) {
    return null;
  }

  return {
    indent: match[1]!.length,
    key: match[2]!,
    value: stripInlineYamlComment(match[3]!).trim(),
  };
}

function stripInlineYamlComment(value: string): string {
  let quote: "\"" | "'" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if ((char === "\"" || char === "'") && (index === 0 || value[index - 1] !== "\\")) {
      quote = quote === char ? null : quote ?? char;
    }

    if (char === "#" && quote === null && (index === 0 || /\s/.test(value[index - 1]!))) {
      return value.slice(0, index);
    }
  }

  return value;
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function leadingSpaceCount(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

async function removeWorktrees(context: ProjectContext): Promise<void> {
  const candidates = context.choices.filter((choice) => !choice.isMain);
  const active = activeSource(context);

  if (candidates.length === 0) {
    throw new CliError("No removable worktrees found. ROOT cannot be removed by treeswitch.");
  }

  if (!process.stdin.isTTY) {
    throw new CliError(`Choose worktrees to remove from an interactive terminal:\n${formatNumberedChoiceList(candidates, active)}`);
  }

  const selected = await selectWorktreesToRemove(candidates, active);
  if (selected.length === 0) {
    throw new CliError("No worktrees selected.");
  }

  const confirmed = await confirmRemoveWorktrees(selected);
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
  let selectedIndex = 0;
  const checked = new Set<number>();

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

    const render = (): void => {
      const lines = [
        "Select worktrees to remove",
        "Space toggles, Up/Down or j/k moves, Enter continues, q cancels.",
        "",
      ];

      for (let index = 0; index < choices.length; index += 1) {
        const choice = choices[index]!;
        const checkbox = checked.has(index) ? "[x]" : "[ ]";
        const line = `${checkbox} ${formatChoiceLabel(choice, active)}`;
        lines.push(index === selectedIndex ? `\x1b[7m> ${line}\x1b[0m` : `  ${line}`);
      }

      writeInlineBlock(lines, renderedLines);
      renderedLines = lines.length;
    };

    const finish = (): void => {
      cleanup();
      resolve([...checked].sort((left, right) => left - right).map((index) => choices[index]!));
    };

    const cancel = (): void => {
      cleanup();
      process.stderr.write("Canceled.\n");
      reject(new CliError("Canceled."));
    };

    const toggle = (): void => {
      if (checked.has(selectedIndex)) {
        checked.delete(selectedIndex);
      } else {
        checked.add(selectedIndex);
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
        case "space":
          toggle();
          return;
        case "q":
          cancel();
          return;
        case "up":
        case "k":
          selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : choices.length - 1;
          render();
          return;
        case "down":
        case "j":
          selectedIndex = (selectedIndex + 1) % choices.length;
          render();
          return;
        default:
          if (value === " ") {
            toggle();
          }
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

async function confirmRemoveWorktrees(choices: WorktreeChoice[]): Promise<boolean> {
  process.stderr.write("\nThe following worktrees will be removed:\n");
  for (const choice of choices) {
    process.stderr.write(`  ${choice.label}\n`);
    process.stderr.write(`    ${choice.path}\n`);
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
    clearRemovedActiveSource(".live-tree/src", context.liveDir, context.srcLink, context.stateFile, removed),
    clearRemovedActiveSource("live-tree/src", context.legacyLiveDir, context.legacySrcLink, context.legacyStateFile, removed),
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
  return (
    activeSourceFrom(context.liveDir, context.srcLink, context.stateFile) ??
    activeSourceFrom(context.legacyLiveDir, context.legacySrcLink, context.legacyStateFile)
  );
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

  for (const line of lines) {
    readline.clearLine(process.stderr, 0);
    readline.cursorTo(process.stderr, 0);
    process.stderr.write(`${line}\n`);
  }
}

function formatChoiceLabel(choice: WorktreeChoice, active: string | null): string {
  const marker = active && samePath(choice.path, active) ? "*" : " ";
  return `${marker} ${choice.label}`;
}

function formatChoiceList(choices: WorktreeChoice[], active: string | null): string {
  return choices.map((choice) => `  ${formatChoiceLabel(choice, active)}`).join("\n");
}

function formatNumberedChoiceList(choices: WorktreeChoice[], active: string | null): string {
  return choices.map((choice, index) => `  ${index + 1}. ${formatChoiceLabel(choice, active)}`).join("\n");
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
