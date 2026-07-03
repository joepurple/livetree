import assert from "node:assert/strict";
import test from "node:test";
import { CliError, WorktreeRemoveNeedsForceError, WorktreeRemovePrunableError, commandFailureMessage, errorMessage } from "../../dist/errors.js";

test("CliError carries an exit code", () => {
  const error = new CliError("nope", 42);
  assert.equal(error.message, "nope");
  assert.equal(error.exitCode, 42);
});

test("specialized worktree errors are CLI errors", () => {
  assert.ok(new WorktreeRemoveNeedsForceError("dirty") instanceof CliError);
  assert.ok(new WorktreeRemovePrunableError("prunable") instanceof CliError);
});

test("formats unknown errors and command failures", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(commandFailureMessage({ stderr: " bad \n", stdout: "ignored" }), "bad");
  assert.equal(commandFailureMessage({ stdout: " ok \n" }), "ok");
  assert.equal(commandFailureMessage("missing"), "missing");
});
