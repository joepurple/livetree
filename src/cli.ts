#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

type WorktreeRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
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

const usage = `Usage:
  treeswitch
  treeswitch <selector>
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

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = stripHeadsPrefix(line.slice("branch ".length));
      } else if (line === "bare") {
        bare = true;
      }
    }

    if (worktreePath) {
      records.push({ path: worktreePath, head, branch, bare });
    }
  }

  return records;
}

function enrichWorktree(record: WorktreeRecord, isMain: boolean): WorktreeChoice {
  if (isMain) {
    return {
      ...record,
      isMain,
      chat: null,
      ref: record.branch,
      label: "MAIN",
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

async function removeWorktrees(context: ProjectContext): Promise<void> {
  const candidates = context.choices.filter((choice) => !choice.isMain);
  const active = activeSource(context);

  if (candidates.length === 0) {
    throw new CliError("No removable worktrees found. MAIN cannot be removed by treeswitch.");
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
    removeGitWorktree(context, choice);
    removed.push(choice);
    console.log(`Removed: ${choice.label}`);
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

  const answer = await askQuestion(`\nType "delete" to remove ${choices.length} worktree${choices.length === 1 ? "" : "s"}: `);
  return answer.trim() === "delete";
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

function removeGitWorktree(context: ProjectContext, choice: WorktreeChoice): void {
  try {
    execFileSync("git", ["worktree", "remove", choice.path], {
      cwd: context.mainRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CliError(formatGitFailure(error, `git worktree remove ${choice.path}`));
  }
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
