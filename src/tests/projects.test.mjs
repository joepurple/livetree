import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isConfiguredProject, registerProject, registeredProjectPaths, unregisterProject } from "../../dist/projects.js";
import { tempDir, withEnv } from "./helpers.mjs";

test("registers projects by most recent use in an isolated catalog", async (t) => {
  const home = tempDir("projects-home", t);
  const first = tempDir("projects-first", t);
  const second = tempDir("projects-second", t);
  writeFileSync(path.join(first, ".ltconf"), "name: first\n");

  await withEnv({ LIVETREE_HOME: home }, async () => {
    registerProject(first, 10);
    registerProject(second, 20);
    registerProject(first, 30);

    assert.deepEqual(registeredProjectPaths(), [first, second]);
    assert.equal(isConfiguredProject(first), true);
    assert.equal(isConfiguredProject(second), false);
    const catalog = JSON.parse(readFileSync(path.join(home, "projects.json"), "utf8"));
    assert.equal(catalog.version, 1);
    assert.equal(catalog.projects.length, 2);

    assert.equal(unregisterProject(first), true);
    assert.deepEqual(registeredProjectPaths(), [second]);
    assert.equal(unregisterProject(first), false);
  });
});

test("ignores an invalid project catalog", async (t) => {
  const home = tempDir("projects-invalid", t);
  writeFileSync(path.join(home, "projects.json"), "not json\n");

  await withEnv({ LIVETREE_HOME: home }, async () => {
    assert.deepEqual(registeredProjectPaths(), []);
  });
});
