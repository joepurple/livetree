import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { confirmYesNo, dim, dropLastCharacter, escapeControlCharacters, formatRelativeAge, printableKeypressValue, reverse, writeInlineBlock } from "../../dist/terminal.js";
import { withEnv, withProperty } from "./helpers.mjs";

test("formats relative ages across ranges", async (t) => {
  const originalNow = Date.now;
  t.after(() => {
    Date.now = originalNow;
  });

  Date.now = () => 1_000_000_000;
  assert.equal(formatRelativeAge(Number.NaN), "?");
  assert.equal(formatRelativeAge(1_000_000_000), "0m");
  assert.equal(formatRelativeAge(1_000_000_000 - 5 * 60_000), "5m");
  assert.equal(formatRelativeAge(1_000_000_000 - 2 * 60 * 60_000), "2h");
  assert.equal(formatRelativeAge(1_000_000_000 - 3 * 24 * 60 * 60_000), "3d");
  assert.equal(formatRelativeAge(1_000_000_000 - 3 * 7 * 24 * 60 * 60_000), "3w");
  assert.equal(formatRelativeAge(1_000_000_000 - 90 * 24 * 60 * 60_000), "3mo");
  assert.equal(formatRelativeAge(1_000_000_000 - 400 * 24 * 60 * 60_000), "1y");
});

test("formats terminal styles when color is available", async () => {
  await withEnv({ NO_COLOR: undefined }, async () => {
    assert.equal(dim("quiet", { isTTY: true }), "\x1b[2mquiet\x1b[0m");
    await withProperty(process.stderr, "isTTY", true, async () => {
      assert.equal(reverse("selected"), "\x1b[7mselected\x1b[0m");
    });
  });

  await withEnv({ NO_COLOR: "1" }, async () => {
    assert.equal(dim("quiet", { isTTY: true }), "quiet");
    assert.equal(reverse("selected"), "selected");
  });

  assert.equal(dim("plain", { isTTY: false }), "plain");
});

test("handles keypress and control character helpers", () => {
  assert.equal(printableKeypressValue("a", {}), "a");
  assert.equal(printableKeypressValue("\n", {}), null);
  assert.equal(printableKeypressValue("a", { ctrl: true }), null);
  assert.equal(printableKeypressValue("a", { meta: true }), null);
  assert.equal(dropLastCharacter("ab🙂"), "ab");
  assert.equal(escapeControlCharacters("a\u0000b\u001fc"), "abc");
});

test("writeInlineBlock accepts an empty render", () => {
  writeInlineBlock([], 0);
});

test("confirmYesNo accepts yes answers and rejects others", async () => {
  async function answer(value) {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const result = withProperty(process, "stdin", input, async () =>
      withProperty(process, "stderr", output, async () => confirmYesNo("Continue? ")),
    );
    input.end(value);
    return result;
  }

  assert.equal(await answer(" YES \n"), true);
  assert.equal(await answer("no\n"), false);
});
