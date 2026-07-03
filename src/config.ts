import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError, errorMessage } from "./errors.js";
import type { LtConfig, ProjectContext } from "./types.js";

type ParsedLtConfig = {
  initScript: string | null;
  copyFiles: string[];
  runScripts: Record<string, string>;
};

type YamlRecord = Record<string, unknown>;

export function readLtConfig(context: ProjectContext): LtConfig {
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

export function parseLtConfig(source: string): ParsedLtConfig {
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
