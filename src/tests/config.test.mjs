import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseLtConfig, readLtConfig, tryReadLtConfig } from "../../dist/config.js";
import { CliError } from "../../dist/errors.js";
import { makeContext, tempDir } from "./helpers.mjs";

const parse = (source) => parseLtConfig(source, "/repo/.ltconf", "fallback");

test("parses .ltconf v2 including tunnel env and links", () => {
  assert.deepEqual(parse(`
name: My Project
init:
  copy: [modules/api/.env, 123]
  script: pnpm install
dev:
  api: pnpm api
  web:
    cmd: pnpm web
    env: { API_BASE: "\${url:api}" }
    tunnelEnv: { API_BASE: "\${tunnelUrl:api}" }
    portArg: --port
    tunnelPort: app
links:
  device: "app://open?url=\${enc:tunnelUrl:web}"
`), {
    configPath: "/repo/.ltconf",
    name: "my-project",
    initScript: "pnpm install",
    copyFiles: [path.join("modules", "api", ".env"), "123"],
    devScripts: {
      api: { name: "api", cmd: "pnpm api", env: {}, tunnelEnv: {}, portArg: null, tunnelPort: "auto" },
      web: {
        name: "web", cmd: "pnpm web", env: { API_BASE: "${url:api}" },
        tunnelEnv: { API_BASE: "${tunnelUrl:api}" }, portArg: "--port", tunnelPort: "app",
      },
    },
    links: { device: "app://open?url=${enc:tunnelUrl:web}" },
  });
});

test("always reads config from the main worktree", (t) => {
  const root = tempDir("config", t);
  writeFileSync(path.join(root, ".ltconf"), "dev:\n  web: npm run web\n");
  const config = readLtConfig(makeContext(root));
  assert.equal(config.name, path.basename(root).slice(0, 24));
  assert.equal(config.devScripts.web.cmd, "npm run web");
  assert.equal(tryReadLtConfig({ mainRoot: tempDir("no-config", t) }), null);
});

test("rejects v1, unsafe paths, invalid env, and malformed definitions", () => {
  assert.throws(() => parse("run:\n  web: npm start\n"), /Unknown .ltconf key/);
  assert.throws(() => parse("init: npm install\n"), /must be a mapping/);
  assert.throws(() => parse("init:\n  copy: [../secret]\n"), /relative files inside/);
  assert.throws(() => parse("dev:\n  bad name: npm start\n"), /Dev script names/);
  assert.throws(() => parse("dev:\n  web:\n    cmd: npm start\n    env:\n      A=B: nope\n"), /invalid environment variable/);
  assert.throws(() => parse("dev:\n  web:\n    cmd: ''\n"), /non-empty 'cmd'/);
  assert.throws(() => parse("dev:\n  web:\n    cmd: npm start\n    tunnelPort: 8443\n"), /tunnelPort must be 'auto' or 'app'/);
  assert.throws(() => parse("["), CliError);
});
