import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { CliError } from "./errors.js";
import type { WorktreeRecord } from "./types.js";

export function git(args: string[], cwd: string, errorMessage?: string): string {
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

export function gitAsync(args: string[], cwd: string, errorMessage?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(new CliError(errorMessage ?? `Git command failed: git ${args.join(" ")}`));
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}

export function gitCommonDir(root: string): string {
  const common = git(["rev-parse", "--git-common-dir"], root);
  return path.isAbsolute(common) ? common : path.resolve(root, common);
}

export function parseWorktreeList(output: string): WorktreeRecord[] {
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

export function stripHeadsPrefix(value: string): string {
  return value.replace(/^refs\/heads\//, "");
}
