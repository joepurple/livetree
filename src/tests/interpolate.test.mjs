import assert from "node:assert/strict";
import test from "node:test";
import { interpolateTemplate, templateTokens } from "../../dist/interpolate.js";

const resolver = {
  urlForScript: (script) => `https://${script}.localhost`,
  tunnelUrlForScript: (script) => `https://devbox.tail.ts.net/${script}`,
};

test("interpolates local, tunnel, and encoded tokens", () => {
  assert.equal(interpolateTemplate("${url:api}/x", resolver), "https://api.localhost/x");
  assert.equal(interpolateTemplate("app://x?u=${enc:tunnelUrl:web}", resolver), "app://x?u=https%3A%2F%2Fdevbox.tail.ts.net%2Fweb");
  assert.deepEqual(templateTokens("${url:api} ${enc:tunnelUrl:web}").map(({ kind, script, encode }) => ({ kind, script, encode })), [
    { kind: "url", script: "api", encode: false },
    { kind: "tunnelUrl", script: "web", encode: true },
  ]);
  assert.throws(() => interpolateTemplate("${wat:nope}", resolver), /Unknown template token/);
});
