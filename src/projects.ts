import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type ProjectRecord = {
  path: string;
  lastUsedAtMs: number;
};

type ProjectCatalog = {
  version: 1;
  projects: ProjectRecord[];
};

const EMPTY_CATALOG: ProjectCatalog = { version: 1, projects: [] };

export function livetreeHome(): string {
  const override = process.env.LIVETREE_HOME?.trim();
  return path.resolve(override || path.join(os.homedir(), ".livetree"));
}

export function registerProject(mainRoot: string, usedAtMs = Date.now()): void {
  const projectPath = canonicalProjectPath(mainRoot);
  const catalog = readProjectCatalog();
  const projects = catalog.projects
    .filter((project) => project.path !== projectPath)
    .concat({ path: projectPath, lastUsedAtMs: usedAtMs })
    .sort((left, right) => right.lastUsedAtMs - left.lastUsedAtMs || left.path.localeCompare(right.path));
  writeProjectCatalog({ version: 1, projects });
}

export function registeredProjectPaths(): string[] {
  return readProjectCatalog().projects
    .slice()
    .sort((left, right) => right.lastUsedAtMs - left.lastUsedAtMs || left.path.localeCompare(right.path))
    .map((project) => project.path);
}

function canonicalProjectPath(projectPath: string): string {
  try {
    return realpathSync(projectPath);
  } catch {
    return path.resolve(projectPath);
  }
}

function catalogPath(): string {
  return path.join(livetreeHome(), "projects.json");
}

function readProjectCatalog(): ProjectCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(catalogPath(), "utf8"));
  } catch {
    return EMPTY_CATALOG;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_CATALOG;
  }

  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) {
    return EMPTY_CATALOG;
  }

  const valid = projects.flatMap((project): ProjectRecord[] => {
    if (!project || typeof project !== "object" || Array.isArray(project)) return [];
    const candidate = project as Partial<ProjectRecord>;
    if (typeof candidate.path !== "string" || !Number.isFinite(candidate.lastUsedAtMs)) return [];
    return [{ path: canonicalProjectPath(candidate.path), lastUsedAtMs: candidate.lastUsedAtMs! }];
  });

  return { version: 1, projects: valid };
}

function writeProjectCatalog(catalog: ProjectCatalog): void {
  const home = livetreeHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const file = catalogPath();
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

export function isConfiguredProject(projectPath: string): boolean {
  return existsSync(path.join(projectPath, ".ltconf"));
}
