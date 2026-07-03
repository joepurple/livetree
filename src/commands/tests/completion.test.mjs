import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { completeSelectors, zshCompletionScript } from "../../../dist/commands/completion.js";
import { makeChoice, makeContext, tempDir } from "../../tests/helpers.mjs";

test("completeSelectors returns selector candidates matching the prefix", (t) => {
  const root = tempDir("completion-root", t);
  const feature = path.join(root, "feature-worktree");
  const context = makeContext(root, [
    makeChoice({ path: root, branch: "main", isMain: true }),
    makeChoice({
      path: feature,
      branch: "feature",
      head: "abcdef1234567890",
      chat: { title: "Build Search", threadId: "thread-feature" },
    }),
    makeChoice({ path: path.join(root, "web-worktree"), branch: "web" }),
  ]);

  assert.deepEqual(completeSelectors(context, "fea"), ["feature", "feature-worktree"]);
  assert.deepEqual(completeSelectors(context, "roo"), ["root"]);
  assert.ok(completeSelectors(context, "thread").includes("thread-feature"));
  assert.ok(completeSelectors(context, "Build").includes("Build Search"));
  assert.ok(completeSelectors(context, root).includes(feature));
});

test("zshCompletionScript emits zsh completion", () => {
  const script = zshCompletionScript();
  assert.match(script, /#compdef lt/);
  assert.match(script, /command lt __complete selectors/);
  assert.match(script, /compdef _lt lt/);
  assert.match(script, /use\|cd/);
  assert.doesNotMatch(script, /use\|cd\|ls/);
  assert.doesNotMatch(script, /switcher\|list\|go/);
});
