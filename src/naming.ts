import { createHash } from "node:crypto";
import path from "node:path";
import { normalizePath } from "./path-utils.js";
import type { WorktreeRecord } from "./types.js";

const MAX_SLUG_LENGTH = 24;
const MAX_PORTLESS_NAME_LENGTH = 63;

export function sanitizeSlug(value: string, maxLength = MAX_SLUG_LENGTH): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength)
    .replace(/-$/, "");
}

export function worktreeSlug(worktree: Pick<WorktreeRecord, "path" | "branch">): string {
  const fullBranchSlug = worktree.branch ? sanitizeSlug(worktree.branch, Number.MAX_SAFE_INTEGER) : "";
  const branchSlug = shortenWithHash(fullBranchSlug, MAX_SLUG_LENGTH);
  if (branchSlug) {
    return branchSlug;
  }

  return createHash("sha256").update(normalizePath(worktree.path)).digest("hex").slice(0, 8);
}

export function defaultProjectName(mainRoot: string): string {
  return sanitizeSlug(path.basename(mainRoot)) || "project";
}

export function portlessName(projectName: string, worktree: Pick<WorktreeRecord, "path" | "branch">, script: string): string {
  return shortenWithHash(`${projectName}-${worktreeSlug(worktree)}-${script}`, MAX_PORTLESS_NAME_LENGTH);
}

function shortenWithHash(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${value.slice(0, maxLength - suffix.length - 1).replace(/-$/, "")}-${suffix}`;
}
