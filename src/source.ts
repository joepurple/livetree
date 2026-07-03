import { existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { CliError } from "./errors.js";
import { isDanglingSymlink, normalizePath, samePath } from "./path-utils.js";
import type { LivetreeSourceSnapshot, ProjectContext, WorktreeChoice } from "./types.js";

export function activeSource(context: ProjectContext): string | null {
  return activeSourceFrom(context.liveDir, context.srcLink, context.stateFile);
}

export function activeSourceFrom(liveDir: string, srcLink: string, stateFile: string): string | null {
  if (isDanglingSymlink(srcLink) || (existsSync(srcLink) && lstatSync(srcLink).isSymbolicLink())) {
    const link = readlinkSync(srcLink);
    return path.isAbsolute(link) ? link : path.resolve(liveDir, link);
  }

  if (!existsSync(stateFile)) {
    return null;
  }

  return readFileSync(stateFile, "utf8").split(/\r?\n/, 1)[0]?.trim() || null;
}

export function requireRunnableLivetreeSource(context: ProjectContext): LivetreeSourceSnapshot {
  const snapshot = readRunnableLivetreeSource(context);
  if (!snapshot) {
    throw new CliError(`No active .livetree/src target. Run 'lt' to select a worktree first.`);
  }

  return snapshot;
}

export function readRunnableLivetreeSource(context: ProjectContext): LivetreeSourceSnapshot | null {
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

export function clearRemovedActiveSources(context: ProjectContext, removed: WorktreeChoice[]): string[] {
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
