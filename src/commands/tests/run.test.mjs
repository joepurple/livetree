import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runConfiguredScript } from "../../../dist/commands/run.js";
import { makeChoice, makeContext, tempDir, wait, withEnv, withProperty } from "../../tests/helpers.mjs";

function runnableContext(t) {
  const root = tempDir("run-root", t);
  const target = path.join(root, "target");
  mkdirSync(target, { recursive: true });
  const context = makeContext(root, [makeChoice({ path: target, label: "Target" })]);
  mkdirSync(context.liveDir);
  symlinkSync(target, context.srcLink, "dir");
  return { root, target, context };
}

test("runConfiguredScript runs configured commands with livetree env", async (t) => {
  const { root, target, context } = runnableContext(t);
  const output = path.join(root, "run-output.txt");
  writeFileSync(path.join(root, ".ltconf"), `
run:
  capture: node -e "require('fs').writeFileSync(process.env.LT_TEST_OUT, [process.env.LT_SCRIPT, process.env.LT_ACTIVE_WORKTREE, process.env.LT_LIVE_SRC].join('|'))"
`);

  await withEnv({ LT_TEST_OUT: output }, async () => {
    await runConfiguredScript(context, ["capture"], false);
  });

  assert.equal(readFileSync(output, "utf8"), `capture|${target}|${context.srcLink}`);
});

test("runConfiguredScript reports usage and unknown scripts", async (t) => {
  const { root, context } = runnableContext(t);
  writeFileSync(path.join(root, ".ltconf"), "run:\n  capture: echo ok\n");

  await assert.rejects(runConfiguredScript(context, [], false), /Usage: lt run/);
  await assert.rejects(runConfiguredScript(context, ["missing"], false), /No run script named 'missing'/);
  await assert.rejects(runConfiguredScript(context, ["missing"], false, { shortcut: true }), /Unknown command or run script/);
  await assert.rejects(runConfiguredScript(context, ["--bad"], false), /Unknown option/);
});

test("runConfiguredScript propagates command failures and missing live source", async (t) => {
  const { root, context } = runnableContext(t);
  writeFileSync(path.join(root, ".ltconf"), "run:\n  fail: node -e \"process.exit(7)\"\n");

  await assert.rejects(
    runConfiguredScript(context, ["fail"], false),
    (error) => error.exitCode === 7 && /status 7/.test(error.message),
  );

  const missing = makeContext(root, []);
  missing.liveDir = path.join(root, "missing-live");
  missing.srcLink = path.join(missing.liveDir, "src");
  missing.stateFile = path.join(missing.liveDir, ".source");
  await assert.rejects(runConfiguredScript(missing, ["fail"], false), /No active \.livetree\/src target/);
});

test("runConfiguredScript watch mode shuts down on SIGINT", async (t) => {
  const { root, context } = runnableContext(t);
  writeFileSync(path.join(root, ".ltconf"), "run:\n  watchme: node -e \"setInterval(() => {}, 1000)\"\n");

  await withProperty(console, "error", () => undefined, async () => {
    const running = runConfiguredScript(context, ["watchme"], true);
    await wait(250);
    process.emit("SIGINT");
    await assert.rejects(running, /Canceled/);
  });
});
