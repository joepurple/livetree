import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { installTools, upsertManagedBlock } from "../../../dist/commands/install.js";
import { captureConsole, tempDir } from "../../tests/helpers.mjs";

test("upsertManagedBlock appends and replaces the livetree block", () => {
  const block = "# >>> livetree completions >>>\nold\n# <<< livetree completions <<<";
  const first = upsertManagedBlock("export PATH=/bin\n", block);
  assert.equal(first, `export PATH=/bin\n\n${block}\n`);

  const source = "before\n# >>> livetree completions >>>\nold\n# <<< livetree completions <<<\nafter\n";
  const replaced = upsertManagedBlock(source, "# >>> livetree completions >>>\nnew\n# <<< livetree completions <<<");
  assert.equal(replaced, "before\n# >>> livetree completions >>>\nnew\n# <<< livetree completions <<<\nafter\n");
});

test("installTools writes a managed zshrc completion block", async (t) => {
  const home = tempDir("install-home", t);
  const zshrc = path.join(home, ".zshrc");
  writeFileSync(zshrc, "export PATH=/bin\n", "utf8");

  const { logs } = await captureConsole(() => installTools("tools", { homeDir: home }));
  const contents = readFileSync(zshrc, "utf8");

  assert.match(contents, /# >>> livetree completions >>>/);
  assert.match(contents, /source <\(lt completion zsh\)/);
  assert.match(contents, /# <<< livetree completions <<</);
  assert.match(logs[0], /Installed livetree zsh completion/);

  installTools("tools", { homeDir: home });
  const afterSecondInstall = readFileSync(zshrc, "utf8");
  assert.equal(afterSecondInstall.match(/# >>> livetree completions >>>/g).length, 1);
});
