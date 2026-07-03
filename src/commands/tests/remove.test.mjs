import assert from "node:assert/strict";
import test from "node:test";
import { removeWorktrees } from "../../../dist/commands/remove.js";
import { makeChoice, makeContext, tempDir, withProperty } from "../../tests/helpers.mjs";

test("removeWorktrees rejects when only ROOT exists", async (t) => {
  const root = tempDir("remove-root-only", t);
  await assert.rejects(
    removeWorktrees(makeContext(root, [makeChoice({ path: root, label: "ROOT", isMain: true })])),
    /No removable worktrees/,
  );
});

test("removeWorktrees requires an interactive terminal", async (t) => {
  const root = tempDir("remove-non-tty", t);
  const context = makeContext(root, [
    makeChoice({ path: root, label: "ROOT", isMain: true }),
    makeChoice({ path: `${root}-linked`, label: "Linked" }),
  ]);

  await withProperty(process.stdin, "isTTY", false, async () => {
    await assert.rejects(removeWorktrees(context), /interactive terminal/);
  });
});
