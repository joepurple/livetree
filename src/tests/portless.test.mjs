import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { DEFAULT_PROXY_PORT, pickFreePort, portlessAppArgs, portlessChildEnv, probeAppReachable, probeLocalPort, resolvePortlessCli, splitCommand, urlForName, waitForLocalPort } from "../../dist/portless.js";

test("resolves the bundled CLI and builds portless invocations", () => {
  assert.equal(DEFAULT_PROXY_PORT, 1355);
  assert.match(resolvePortlessCli(), /node_modules\/portless\/dist\/cli\.js$/);
  assert.deepEqual(portlessAppArgs("app-main-web", ["npm", "run", "dev"], null), ["app-main-web", "--", "npm", "run", "dev"]);
  assert.deepEqual(portlessAppArgs("app-main-web", ["vite"], 4567), ["app-main-web", "--app-port", "4567", "--", "vite"]);
  assert.equal(urlForName("app", { port: 443, tls: true }), "https://app.localhost");
  assert.equal(urlForName("app", { port: 8080, tls: false }), "http://app.localhost:8080");
});

test("splits quoted commands without invoking a shell", () => {
  assert.deepEqual(splitCommand(`node -e "console.log('ok')"`), ["node", "-e", "console.log('ok')"]);
  assert.throws(() => splitCommand("npm run x && echo no"), /without a shell/);
  const env = portlessChildEnv({ npm_command: "exec", KEEP: "yes" });
  assert.equal(env.KEEP, "yes");
  assert.equal(env.npm_command, undefined);
});

test("allocates app ports outside the protected range", async () => {
  assert.ok(await pickFreePort() > 1023);
});

test("waits for the allocated app port itself to become reachable", async (t) => {
  const port = await pickFreePort();
  assert.equal(await probeLocalPort(port, 25), false);

  const server = createServer((_request, response) => response.end("ok"));
  t.after(() => server.close());
  const timer = setTimeout(() => server.listen(port, "127.0.0.1"), 50);
  t.after(() => clearTimeout(timer));

  assert.equal(await waitForLocalPort(port, 1_000), true);
});

test("distinguishes an application error from an unreachable proxy target", async (t) => {
  let status = 500;
  const server = createServer((_request, response) => {
    response.writeHead(status).end();
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(await probeAppReachable("app", { port: address.port, tls: false }), true);
  status = 502;
  assert.equal(await probeAppReachable("app", { port: address.port, tls: false }), false);
});
