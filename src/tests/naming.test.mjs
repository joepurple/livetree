import assert from "node:assert/strict";
import test from "node:test";
import { portlessName, sanitizeSlug, worktreeSlug } from "../../dist/naming.js";

test("sanitizes names and uses path hashes for detached worktrees", () => {
  assert.equal(sanitizeSlug(" Hello/World! "), "hello-world");
  assert.match(worktreeSlug({ path: "/tmp/repo", branch: null }), /^[a-f0-9]{8}$/);
});

test("long branch and full names remain unique and valid portless labels", () => {
  const left = worktreeSlug({ path: "/a", branch: "feature/same-very-long-prefix-one" });
  const right = worktreeSlug({ path: "/b", branch: "feature/same-very-long-prefix-two" });
  assert.equal(left.length, 24);
  assert.notEqual(left, right);
  const name = portlessName("a-very-long-project-name", { path: "/a", branch: "feature/same-very-long-prefix-one" }, "an-extremely-long-script-name-that-keeps-going");
  assert.ok(name.length <= 63);
  assert.match(name, /^[a-z0-9-]+$/);
});
