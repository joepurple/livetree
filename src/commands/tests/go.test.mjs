import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { goToWorktree } from "../../../dist/commands/go.js";
import { FakeTTYStdin, makeChoice, makeContext, tempDir, wait, withMutedTerminal, withProperty } from "../../tests/helpers.mjs";

test("goToWorktree copies a cd command for the selected worktree", async (t) => {
  const root = tempDir("go-root", t);
  const api = path.join(root, "api work");
  const web = path.join(root, "web");
  mkdirSync(api);
  mkdirSync(web);
  const context = makeContext(root, [
    makeChoice({ path: api, label: "API Server", branch: "api" }),
    makeChoice({ path: web, label: "Web Client", branch: "web" }),
  ]);
  const copied = [];

  await withProperty(process.stdin, "isTTY", false, async () =>
    withMutedTerminal(async () => goToWorktree(context, "api", { writePasteboard: (value) => copied.push(value) })),
  );

  assert.deepEqual(copied, [`cd '${api}'`]);
});

test("goToWorktree rejects ambiguous non-interactive matches", async (t) => {
  const root = tempDir("go-ambiguous", t);
  const context = makeContext(root, [
    makeChoice({ path: path.join(root, "api"), label: "API Server", branch: "api" }),
    makeChoice({ path: path.join(root, "web"), label: "Web Client", branch: "web" }),
  ]);
  const copied = [];

  await withProperty(process.stdin, "isTTY", false, async () => {
    await assert.rejects(goToWorktree(context, "", { writePasteboard: (value) => copied.push(value) }), /More than one worktree matched/);
  });
  assert.deepEqual(copied, []);
});

test("goToWorktree opens a selectable browser in interactive mode", async (t) => {
  const root = tempDir("go-interactive", t);
  const api = path.join(root, "api");
  const web = path.join(root, "web");
  mkdirSync(api);
  mkdirSync(web);
  const context = makeContext(root, [
    makeChoice({ path: api, label: "API Server", branch: "api" }),
    makeChoice({ path: web, label: "Web Client", branch: "web" }),
  ]);
  const input = new FakeTTYStdin();
  const copied = [];

  await withProperty(process.stdin, "isTTY", true, async () =>
    withProperty(process, "stdin", input, async () =>
      withMutedTerminal(async () => {
        const promise = goToWorktree(context, "web", { writePasteboard: (value) => copied.push(value) });
        await wait(0);
        input.emit("keypress", "\r", { name: "return" });
        await promise;
      }),
    ),
  );

  assert.deepEqual(copied, [`cd '${web}'`]);
});
