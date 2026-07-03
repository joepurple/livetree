import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { listWorktrees } from "../../../dist/commands/list.js";
import { captureConsole, makeChoice, makeContext, tempDir, withProperty } from "../../tests/helpers.mjs";

test("listWorktrees prints all worktrees in non-interactive mode", async (t) => {
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
    captureConsole(() => listWorktrees(context)),
  );

  assert.ok(logs.some((line) => line.includes("API Server")));
  assert.ok(logs.some((line) => line.includes("Web Client")));
});

test("listWorktrees prints and quits in interactive mode", async (t) => {
  const root = tempDir("list-interactive", t);
  const context = makeContext(root, [makeChoice({ path: root, label: "Root" })]);

  const { logs } = await withProperty(process.stdin, "isTTY", true, async () =>
    captureConsole(() => listWorktrees(context)),
  );

  assert.ok(logs.some((line) => line.includes("Root")));
});

test("listWorktrees rejects extra arguments", async (t) => {
  const root = tempDir("list-empty", t);
  const context = makeContext(root, [makeChoice({ path: root, label: "Root" })]);

  await withProperty(process.stdin, "isTTY", false, async () => {
    await assert.rejects(listWorktrees(context, "zzz"), /Usage: lt ls/);
  });
});
