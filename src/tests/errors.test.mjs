import assert from "node:assert/strict";
import test from "node:test";
import { CliError, commandFailureMessage, errorMessage } from "../../dist/errors.js";

test("formats CLI and unknown errors", () => {
  const error = new CliError("nope", 42);
  assert.equal(error.exitCode, 42);
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(commandFailureMessage({ stderr: " bad \n" }), "bad");
  assert.equal(commandFailureMessage({ stdout: " ok \n" }), "ok");
});
