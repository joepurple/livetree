import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  nextTailscaleServePort,
  readTailscaleInfo,
  resolveTailscaleCli,
  tailscaleDnsName,
  tailscaleServeArgs,
  tailscaleServeError,
  tailscaleServePortsFromStatus,
  tailscaleUrl,
} from "../../dist/tailscale.js";
import { tempDir } from "./helpers.mjs";

test("reads connected Tailscale identity and formats Serve URLs", (t) => {
  const root = tempDir("fake-tailscale", t);
  const bin = path.join(root, "tailscale");
  writeFileSync(bin, `#!/bin/sh
printf '%s' '{"BackendState":"Running","Self":{"DNSName":"devbox.example.ts.net.","Online":true}}'
`);
  chmodSync(bin, 0o755);
  assert.equal(resolveTailscaleCli({ LIVETREE_TAILSCALE_BIN: bin }), bin);
  const info = readTailscaleInfo(bin);
  assert.equal(info.dnsName, "devbox.example.ts.net");
  assert.equal(tailscaleUrl(info, 443), "https://devbox.example.ts.net");
  assert.equal(tailscaleUrl(info, 8443), "https://devbox.example.ts.net:8443");
});

test("allocates unused Tailscale HTTPS ports and builds Serve arguments", () => {
  const used = tailscaleServePortsFromStatus(JSON.stringify({ Foreground: { process1: {
    Web: { "devbox.ts.net:443": {}, "devbox.ts.net:8443": {} },
    TCP: { "8444": {} },
  } } }));
  assert.deepEqual([...used].sort((a, b) => a - b), [443, 8443, 8444]);
  assert.equal(nextTailscaleServePort(used), 8445);
  assert.deepEqual(tailscaleServeArgs(43117, 8445), [
    "serve", "--yes", "--https=8445", "http://127.0.0.1:43117",
  ]);
});

test("reports the Tailscale Serve approval link", () => {
  const error = tailscaleServeError(`Serve is not enabled on your tailnet.
https://login.tailscale.com/f/serve?node=node123
`);
  assert.match(error.message, /not enabled.*https:\/\/login\.tailscale\.com\/f\/serve\?node=node123/);
  assert.equal(tailscaleDnsName({ Self: { HostName: "devbox" }, CurrentTailnet: { MagicDNSSuffix: "tail.ts.net." } }), "devbox.tail.ts.net");
});
