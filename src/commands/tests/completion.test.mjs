import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { completeSelectors, printCompletionScript } from "../../../dist/commands/completion.js";
import { captureConsole, makeChoice, makeContext, tempDir } from "../../tests/helpers.mjs";

test("completeSelectors returns selector candidates matching the prefix", (t) => {
  const root = tempDir("completion-root", t);
  const feature = path.join(root, "feature-worktree");
  const context = makeContext(root, [
    makeChoice({
      path: feature,
      branch: "feature",
      head: "abcdef1234567890",
      chat: { title: "Build Search", threadId: "thread-feature" },
    }),
    makeChoice({ path: path.join(root, "web-worktree"), branch: "web" }),
  ]);

  assert.deepEqual(completeSelectors(context, "fea"), ["feature", "feature-worktree"]);
  assert.ok(completeSelectors(context, "thread").includes("thread-feature"));
  assert.ok(completeSelectors(context, "Build").includes("Build Search"));
  assert.ok(completeSelectors(context, root).includes(feature));
});

test("printCompletionScript emits zsh completion", async () => {
  const { logs } = await captureConsole(() => printCompletionScript("zsh"));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /#compdef lt/);
  assert.match(logs[0], /command lt __complete selectors/);
  assert.match(logs[0], /compdef _lt lt/);
});
