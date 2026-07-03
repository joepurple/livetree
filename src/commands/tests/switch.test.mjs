import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveSelector, selectWorktree, switchSource } from "../../../dist/commands/switch.js";
import { FakeTTYStdin, makeChoice, makeContext, tempDir, wait, withMutedTerminal, withProperty } from "../../tests/helpers.mjs";

test("resolves selectors by path, branch, hash, basename, title, and thread", (t) => {
  const root = tempDir("switch-root", t);
  const feature = path.join(root, "feature-worktree");
  const other = path.join(root, "other-worktree");
  mkdirSync(feature);
  mkdirSync(other);

  const featureChoice = makeChoice({
    path: feature,
    label: "Feature Work",
    branch: "feature",
    head: "abcdef123456",
    chat: { title: "Build Search", threadId: "thread-feature" },
  });
  const otherChoice = makeChoice({ path: other, label: "Other Work", branch: "other" });
  const context = makeContext(root, [featureChoice, otherChoice]);

  assert.equal(resolveSelector(context, feature), featureChoice);
  assert.equal(resolveSelector(context, "feature"), featureChoice);
  assert.equal(resolveSelector(context, "abcdef"), featureChoice);
  assert.equal(resolveSelector(context, "feature-worktree"), featureChoice);
  assert.equal(resolveSelector(context, "search"), featureChoice);
  assert.equal(resolveSelector(context, "thread-feature"), featureChoice);
  assert.throws(() => resolveSelector(makeContext(root, [featureChoice, makeChoice({ ...otherChoice, branch: "feature" })]), "feature"), /More than one/);
  assert.throws(() => resolveSelector(context, "missing"), /No worktree matched/);
});

test("selectWorktree requires an interactive terminal", async (t) => {
  const root = tempDir("select-root", t);
  const choice = makeChoice({ path: root, label: "Root", isMain: true });
  await withProperty(process.stdin, "isTTY", false, async () => {
    await assert.rejects(selectWorktree(makeContext(root, [choice])), /Choose a worktree/);
  });
});

test("selectWorktree returns the interactive selection", async (t) => {
  const root = tempDir("select-interactive", t);
  const first = makeChoice({ path: path.join(root, "first"), label: "First" });
  const second = makeChoice({ path: path.join(root, "second"), label: "Second" });
  mkdirSync(first.path);
  mkdirSync(second.path);
  const input = new FakeTTYStdin();

  const selected = await withProperty(process, "stdin", input, async () =>
    withMutedTerminal(async () => {
      const promise = selectWorktree(makeContext(root, [first, second]));
      await wait(0);
      input.emit("keypress", "s", { name: "s" });
      input.emit("keypress", "e", { name: "e" });
      input.emit("keypress", "c", { name: "c" });
      input.emit("keypress", "\r", { name: "return" });
      return promise;
    }),
  );

  assert.equal(selected.label, "Second");
});

test("switchSource writes the live symlink and state file", (t) => {
  const root = tempDir("switch-source", t);
  const target = path.join(root, "target");
  mkdirSync(target);
  const context = makeContext(root, [makeChoice({ path: target })]);

  switchSource(context, makeChoice({ path: target, label: "Target" }));
  assert.equal(lstatSync(context.srcLink).isSymbolicLink(), true);
  assert.equal(readlinkSync(context.srcLink), target);
  assert.equal(readFileSync(context.stateFile, "utf8"), `${target}\n`);

  assert.equal(existsSync(context.srcLink), true);
});

test("switchSource refuses to replace a non-symlink", (t) => {
  const root = tempDir("switch-blocked", t);
  const target = path.join(root, "target");
  mkdirSync(target, { recursive: true });
  const context = makeContext(root);
  mkdirSync(context.liveDir);
  writeFileSync(context.srcLink, "file");

  assert.throws(() => switchSource(context, makeChoice({ path: target })), /Refusing to replace non-symlink/);
});
