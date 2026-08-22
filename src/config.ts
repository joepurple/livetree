import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError, errorMessage } from "./errors.js";
import { defaultProjectName, sanitizeSlug } from "./naming.js";
import type { DevScript, LtConfig, ProjectContext } from "./types.js";

type YamlRecord = Record<string, unknown>;

const EXAMPLE_CONFIG = `name: myproject
init:
  copy:
    - modules/api/.env
  script: pnpm install
dev:
  api:
    cmd: pnpm --dir modules/api start
  web:
    cmd: pnpm --dir modules/web start
    env:
      API_BASE: \${url:api}`;

export function readLtConfig(context: Pick<ProjectContext, "mainRoot">): LtConfig {
  const config = tryReadLtConfig(context);
  if (!config) {
    throw new CliError(`No .ltconf found at ${path.join(context.mainRoot, ".ltconf")}.\n\nAdd one like:\n${EXAMPLE_CONFIG}`);
  }

  return config;
}

export function tryReadLtConfig(context: Pick<ProjectContext, "mainRoot">): LtConfig | null {
  const configPath = path.join(context.mainRoot, ".ltconf");
  if (!existsSync(configPath)) {
    return null;
  }

  return parseLtConfig(readFileSync(configPath, "utf8"), configPath, defaultProjectName(context.mainRoot));
}

export function parseLtConfig(source: string, configPath: string, fallbackName: string): LtConfig {
  const parsed = parseLtConfigYaml(source);

  for (const key of Object.keys(parsed)) {
    if (!["name", "init", "dev", "links"].includes(key)) {
      throw new CliError(`Unknown .ltconf key '${key}'. Supported keys: name, init, dev, links.`);
    }
  }

  return {
    configPath,
    name: parseProjectName(parsed.name, fallbackName),
    ...parseInitSection(parsed.init),
    devScripts: parseDevSection(parsed.dev),
    links: parseLinksSection(parsed.links),
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

function parseProjectName(value: unknown, fallbackName: string): string {
  if (value === undefined || value === null) {
    return fallbackName;
  }

  const name = yamlScalarString(value);
  if (!name) {
    throw new CliError(".ltconf 'name' must be a non-empty string.");
  }

  const slug = sanitizeSlug(name);
  if (!slug) {
    throw new CliError(`.ltconf 'name' must contain letters or digits: ${name}`);
  }

  return slug;
}

function parseInitSection(value: unknown): Pick<LtConfig, "initScript" | "copyFiles"> {
  if (value === undefined || value === null) {
    return { initScript: null, copyFiles: [] };
  }

  if (!isYamlRecord(value)) {
    throw new CliError(".ltconf 'init' must be a mapping with 'copy' and/or 'script'.");
  }

  for (const key of Object.keys(value)) {
    if (!["copy", "script"].includes(key)) {
      throw new CliError(`Unknown .ltconf init key '${key}'. Supported keys: copy, script.`);
    }
  }

  return {
    initScript: yamlScalarString(value.script),
    copyFiles: normalizeCopyFilePaths(yamlStringList(value.copy)),
  };
}

function parseDevSection(value: unknown): Record<string, DevScript> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isYamlRecord(value)) {
    throw new CliError(".ltconf 'dev' must be a mapping of script names to script definitions.");
  }

  const scripts: Record<string, DevScript> = {};
  for (const [name, definition] of Object.entries(value)) {
    const trimmedName = name.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmedName)) {
      throw new CliError(`Dev script names must use lowercase letters, digits, or hyphens and start with a letter or digit: ${name}`);
    }

    scripts[trimmedName] = parseDevScript(trimmedName, definition);
  }

  return scripts;
}

function parseDevScript(name: string, definition: unknown): DevScript {
  const shorthandCmd = yamlScalarString(definition);
  if (shorthandCmd) {
    return { name, cmd: shorthandCmd, env: {}, tunnelEnv: {}, portArg: null };
  }

  if (!isYamlRecord(definition)) {
    throw new CliError(`Dev script '${name}' must be a mapping with a 'cmd'.`);
  }

  for (const key of Object.keys(definition)) {
    if (!["cmd", "env", "tunnelEnv", "portArg"].includes(key)) {
      throw new CliError(`Unknown key '${key}' in dev script '${name}'. Supported keys: cmd, env, tunnelEnv, portArg.`);
    }
  }

  const cmd = yamlScalarString(definition.cmd);
  if (!cmd) {
    throw new CliError(`Dev script '${name}' must define a non-empty 'cmd'.`);
  }

  return {
    name,
    cmd,
    env: parseEnvMap(name, definition.env),
    tunnelEnv: parseEnvMap(name, definition.tunnelEnv, "tunnelEnv"),
    portArg: yamlScalarString(definition.portArg),
  };
}

function parseEnvMap(scriptName: string, value: unknown, field = "env"): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isYamlRecord(value)) {
    throw new CliError(`Dev script '${scriptName}' ${field} must be a mapping of variable names to values.`);
  }

  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliError(`Dev script '${scriptName}' ${field} contains an invalid environment variable name: ${key}`);
    }
    const scalarValue = yamlScalarString(envValue) ?? (envValue === "" ? "" : null);
    if (scalarValue === null) {
      throw new CliError(`Dev script '${scriptName}' ${field} value for '${key}' must be a string.`);
    }

    env[key] = scalarValue;
  }

  return env;
}

function parseLinksSection(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isYamlRecord(value)) {
    throw new CliError(".ltconf 'links' must be a mapping of link names to URL templates.");
  }

  const links: Record<string, string> = {};
  for (const [name, template] of Object.entries(value)) {
    const scalarValue = yamlScalarString(template);
    if (!scalarValue) {
      throw new CliError(`Link '${name}' must be a non-empty URL template.`);
    }

    links[name] = scalarValue;
  }

  return links;
}

function yamlStringList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

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
