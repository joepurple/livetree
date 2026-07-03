import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { firstPositiveNumber, isDanglingSymlink, maxPositiveNumber, normalizePath, pathModifiedAtMs, resolveExistingPath, samePath } from "../../dist/path-utils.js";
import { tempDir } from "./helpers.mjs";

test("resolves, normalizes, and compares paths", (t) => {
  const root = tempDir("paths", t);
  const target = path.join(root, "target");
  mkdirSync(target);
  const link = path.join(root, "link");
  symlinkSync(target, link, "dir");

  assert.equal(resolveExistingPath("target", root), normalizePath(target));
  assert.equal(resolveExistingPath("missing", root), null);
  assert.equal(samePath(target, link), true);
  assert.equal(normalizePath(path.join(root, "missing")), path.join(root, "missing"));
});

test("detects symlinks and modification times", (t) => {
  const root = tempDir("mtime", t);
  const file = path.join(root, "file.txt");
  writeFileSync(file, "hello");
  const link = path.join(root, "dangling-link");
  symlinkSync(path.join(root, "missing"), link);

  assert.equal(isDanglingSymlink(link), true);
  assert.equal(isDanglingSymlink(path.join(root, "missing")), false);
  assert.equal(typeof pathModifiedAtMs(file), "number");
  assert.equal(pathModifiedAtMs(path.join(root, "missing")), null);
});

test("selects positive numbers", () => {
  assert.equal(maxPositiveNumber(null, -1, 0, 4, 3), 4);
  assert.equal(maxPositiveNumber(null, Number.NaN), null);
  assert.equal(firstPositiveNumber(0, -2, 5, 6), 5);
  assert.equal(firstPositiveNumber(0, Number.NaN), null);
});
