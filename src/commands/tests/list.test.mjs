import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { listWorktrees } from "../../../dist/commands/list.js";
import { FakeTTYStdin, captureConsole, makeChoice, makeContext, tempDir, wait, withMutedTerminal, withProperty } from "../../tests/helpers.mjs";

test("listWorktrees prints filtered worktrees in non-interactive mode", async (t) => {
  const root = tempDir("list-root", t);
  const api = path.join(root, "api");
  const web = path.join(root, "web");
  mkdirSync(api);
  mkdirSync(web);
  const context = makeContext(root, [
    makeChoice({ path: api, label: "API Server", branch: "api" }),
    makeChoice({ path: web, label: "Web Client", branch: "web" }),
  ]);

  const { logs } = await withProperty(process.stdin, "isTTY", false, async () =>
    captureConsole(() => listWorktrees(context, "api")),
  );

  assert.ok(logs.some((line) => line.includes("API Server")));
  assert.ok(!logs.some((line) => line.includes("Web Client")));
});

test("listWorktrees errors when no non-interactive match exists", async (t) => {
  const root = tempDir("list-empty", t);
  const context = makeContext(root, [makeChoice({ path: root, label: "Root" })]);

  await withProperty(process.stdin, "isTTY", false, async () => {
    await assert.rejects(listWorktrees(context, "zzz"), /No worktrees matched/);
  });
});

test("listWorktrees opens the browser in interactive mode", async (t) => {
  const root = tempDir("list-interactive", t);
  const context = makeContext(root, [makeChoice({ path: root, label: "Root" })]);
  const input = new FakeTTYStdin();

  await withProperty(process.stdin, "isTTY", true, async () =>
    withProperty(process, "stdin", input, async () =>
      withMutedTerminal(async () => {
        const promise = listWorktrees(context, "roo");
        await wait(0);
        input.emit("keypress", "", { name: "escape" });
        input.emit("keypress", "", { name: "escape" });
        await promise;
      }),
    ),
  );
});
