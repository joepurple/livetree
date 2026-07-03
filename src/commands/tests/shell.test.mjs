import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runShellCommand, watchShellCommand } from "../../../dist/commands/shell.js";
import { makeChoice, makeContext, tempDir, wait, withEnv, withProperty } from "../../tests/helpers.mjs";

function shellContext(t) {
  const root = tempDir("shell-root", t);
  const target = path.join(root, "target");
  mkdirSync(target, { recursive: true });
  const context = makeContext(root, [makeChoice({ path: target })]);
  mkdirSync(context.liveDir);
  symlinkSync(target, context.srcLink, "dir");
  return { root, target, context };
}

test("runShellCommand runs in the active source with livetree env", async (t) => {
  const { root, target, context } = shellContext(t);
  const output = path.join(root, "shell-output.txt");

  await withEnv({ LT_TEST_OUT: output }, async () => {
    runShellCommand(context, [
      "node",
      "-e",
      "require('fs').writeFileSync(process.env.LT_TEST_OUT, process.cwd() + '|' + process.env.LT_ACTIVE_WORKTREE + '|' + process.env.LT_PROJECT_ROOT)",
    ]);
  });

  assert.equal(readFileSync(output, "utf8"), `${target}|${target}|${root}`);
});

test("shell commands require command args", async (t) => {
  const { context } = shellContext(t);
  assert.throws(() => runShellCommand(context, [], ":"), /Usage: lt :/);
  await assert.rejects(watchShellCommand(context, []), /Usage: lt watch:/);
});

test("runShellCommand propagates command failures", (t) => {
  const { context } = shellContext(t);
  assert.throws(
    () => runShellCommand(context, ["node -e \"process.exit(9)\""]),
    (error) => error.exitCode === 9 && /status 9/.test(error.message),
  );
});

test("watchShellCommand shuts down on SIGINT", async (t) => {
  const { context } = shellContext(t);

  await withProperty(console, "error", () => undefined, async () => {
    const running = watchShellCommand(context, ["node -e \"setInterval(() => {}, 1000)\""]);
    await wait(250);
    process.emit("SIGINT");
    await assert.rejects(running, /Canceled/);
  });
});
