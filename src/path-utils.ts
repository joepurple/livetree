import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export function resolveExistingPath(value: string, cwd: string): string | null {
  const candidate = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  if (!existsSync(candidate)) {
    return null;
  }

  return normalizePath(candidate);
}

export function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

export function normalizePath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

export function isDanglingSymlink(value: string): boolean {
  try {
    return lstatSync(value).isSymbolicLink();
  } catch {
    return false;
  }
}

export function pathModifiedAtMs(value: string): number | null {
  try {
    const stats = lstatSync(value);
    return maxPositiveNumber(stats.mtimeMs, stats.ctimeMs);
  } catch {
    return null;
  }
}

export function maxPositiveNumber(...values: Array<number | null | undefined>): number | null {
  let maximum: number | null = null;
  for (const value of values) {
    if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) {
      continue;
    }

    maximum = maximum === null ? value : Math.max(maximum, value);
  }

  return maximum;
}

export function firstPositiveNumber(...values: number[]): number | null {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
}
