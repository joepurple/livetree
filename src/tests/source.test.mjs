import assert from "node:assert/strict";
import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { activeSource, activeSourceFrom, clearRemovedActiveSources, readRunnableLivetreeSource, requireRunnableLivetreeSource } from "../../dist/source.js";
import { makeChoice, makeContext, tempDir } from "./helpers.mjs";

test("reads active source from symlink or state file", (t) => {
  const root = tempDir("source", t);
  const target = path.join(root, "worktree");
  mkdirSync(target);
  const liveDir = path.join(root, ".livetree");
  mkdirSync(liveDir);
  const srcLink = path.join(liveDir, "src");
  const stateFile = path.join(liveDir, ".source");

  symlinkSync(target, srcLink, "dir");
  assert.equal(activeSourceFrom(liveDir, srcLink, stateFile), target);

  unlinkSync(srcLink);
  writeFileSync(stateFile, `${target}\n`);
  assert.equal(activeSourceFrom(liveDir, srcLink, stateFile), target);
});

test("reads runnable source snapshots", (t) => {
  const root = tempDir("runnable-source", t);
  const target = path.join(root, "worktree");
  mkdirSync(target, { recursive: true });
  const context = makeContext(root);
  mkdirSync(context.liveDir);

  assert.equal(readRunnableLivetreeSource(context), null);
  assert.throws(() => requireRunnableLivetreeSource(context), /No active \.livetree\/src target/);

  symlinkSync(target, context.srcLink, "dir");
  assert.deepEqual(readRunnableLivetreeSource(context), {
    source: target,
    key: target,
  });

  unlinkSync(context.srcLink);
  writeFileSync(context.srcLink, "not a symlink");
  assert.throws(() => readRunnableLivetreeSource(context), /non-symlink/);
});

test("readRunnableLivetreeSource ignores stale state files", (t) => {
  const root = tempDir("stale-source", t);
  const context = makeContext(root);
  mkdirSync(context.liveDir);
  writeFileSync(context.stateFile, `${path.join(root, "missing")}\n`);

  assert.equal(readRunnableLivetreeSource(context), null);
});

test("clears active source when a removed worktree was selected", (t) => {
  const root = tempDir("clear-source", t);
  const target = path.join(root, "worktree");
  mkdirSync(target, { recursive: true });
  const context = makeContext(root);
  mkdirSync(context.liveDir);
  symlinkSync(target, context.srcLink, "dir");
  writeFileSync(context.stateFile, `${target}\n`);

  assert.equal(activeSource(context), target);
  assert.deepEqual(clearRemovedActiveSources(context, [makeChoice({ path: target })]), [".livetree/src"]);
  assert.equal(existsSync(context.srcLink), false);
  assert.equal(existsSync(context.stateFile), false);
  assert.deepEqual(clearRemovedActiveSources(context, [makeChoice({ path: path.join(root, "other") })]), []);
});
