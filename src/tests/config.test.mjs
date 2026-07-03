import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseLtConfig, readLtConfig } from "../../dist/config.js";
import { CliError } from "../../dist/errors.js";
import { makeContext, tempDir } from "./helpers.mjs";

test("parses the structured init and run config", () => {
  const config = parseLtConfig(`
init:
  copy:
    - modules/api/.env
    - 123
  script: pnpm install
run:
  web: cd src/modules/web && pnpm start
  api: pnpm api
`);

  assert.deepEqual(config, {
    initScript: "pnpm install",
    copyFiles: ["modules/api/.env", "123"],
    runScripts: {
      web: "cd src/modules/web && pnpm start",
      api: "pnpm api",
    },
  });
});

test("parses supported init shorthands", () => {
  assert.equal(parseLtConfig("init: npm install\n").initScript, "npm install");
  assert.equal(parseLtConfig("initCommand: true\n").initScript, "true");
  assert.equal(parseLtConfig("scripts:\n  init: npm ci\n").initScript, "npm ci");
});

test("readLtConfig normalizes relative copy paths and run scripts", (t) => {
  const root = tempDir("config", t);
  writeFileSync(path.join(root, ".ltconf"), `
init:
  copy:
    - ./packages/app/.env
  script: npm install
run:
  web-app: npm run web
`);

  assert.deepEqual(readLtConfig(makeContext(root)), {
    configPath: path.join(root, ".ltconf"),
    initScript: "npm install",
    copyFiles: [path.join("packages", "app", ".env")],
    runScripts: {
      "web-app": "npm run web",
    },
  });
});

test("readLtConfig rejects missing, invalid, and unsafe config", (t) => {
  const missingRoot = tempDir("missing-config", t);
  assert.throws(() => readLtConfig(makeContext(missingRoot)), /No \.ltconf found/);

  const invalidYamlRoot = tempDir("invalid-yaml", t);
  writeFileSync(path.join(invalidYamlRoot, ".ltconf"), "init: [");
  assert.throws(() => readLtConfig(makeContext(invalidYamlRoot)), /Invalid \.ltconf YAML/);

  assert.throws(() => parseLtConfig("- just\n- a list\n"), /must contain a YAML mapping/);

  const unsafeCopyRoot = tempDir("unsafe-copy", t);
  writeFileSync(path.join(unsafeCopyRoot, ".ltconf"), "init:\n  copy:\n    - ../secret\n  script: npm install\n");
  assert.throws(() => readLtConfig(makeContext(unsafeCopyRoot)), /relative files inside the project/);

  const badRunRoot = tempDir("bad-run", t);
  writeFileSync(path.join(badRunRoot, ".ltconf"), "run:\n  bad name: npm start\n");
  assert.throws(() => readLtConfig(makeContext(badRunRoot)), /Run script names/);

  const emptyRunRoot = tempDir("empty-run", t);
  writeFileSync(path.join(emptyRunRoot, ".ltconf"), "run:\n  web: ''\n");
  assert.throws(() => readLtConfig(makeContext(emptyRunRoot)), /must not be empty/);
});

test("config errors use CliError", () => {
  assert.throws(() => parseLtConfig("["), CliError);
});
