import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { firstPositiveNumber, maxPositiveNumber, normalizePath, pathModifiedAtMs, samePath } from "../../dist/path-utils.js";
import { tempDir } from "./helpers.mjs";

test("normalizes paths and reads modification times", (t) => {
  const root = tempDir("paths", t);
  const target = path.join(root, "target");
  mkdirSync(target);
  const link = path.join(root, "link");
  symlinkSync(target, link, "dir");
  const file = path.join(root, "file");
  writeFileSync(file, "hello");
  assert.equal(samePath(target, link), true);
  assert.equal(normalizePath(path.join(root, "missing")), path.join(root, "missing"));
  assert.equal(typeof pathModifiedAtMs(file), "number");
  assert.equal(pathModifiedAtMs(path.join(root, "missing")), null);
  assert.equal(maxPositiveNumber(null, -1, 4, 3), 4);
  assert.equal(firstPositiveNumber(0, -2, 5, 6), 5);
});
