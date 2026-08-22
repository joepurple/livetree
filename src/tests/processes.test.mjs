import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { processTreePids, stopProcessGroupAndWait } from "../../dist/processes.js";
import { isProcessAlive } from "../../dist/registry.js";

test("stops detached descendant process groups with their wrapper", async (t) => {
  const source = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    'process.stdout.write(String(child.pid) + "\\n");',
    'setInterval(() => {}, 1000);',
  ].join("\n");
  const wrapper = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  assert.ok(wrapper.pid);
  const childPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child PID")), 2_000);
    wrapper.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(Number.parseInt(chunk.toString("utf8").trim(), 10));
    });
  });
  t.after(() => {
    try { process.kill(-wrapper.pid, "SIGKILL"); } catch {}
    try { process.kill(-childPid, "SIGKILL"); } catch {}
  });

  assert.ok(processTreePids(wrapper.pid).includes(childPid));
  await stopProcessGroupAndWait(wrapper.pid, 2_000);
  assert.equal(isProcessAlive(wrapper.pid), false);
  assert.equal(isProcessAlive(childPid), false);
});
