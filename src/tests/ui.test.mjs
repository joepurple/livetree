import assert from "node:assert/strict";
import test from "node:test";
import {
  ageColumnWidth,
  browseInteractiveWorktreeList,
  filterWorktreeListItems,
  formatChoiceList,
  formatNumberedChoiceList,
  formatWorktreeListRow,
  printWorktreeList,
  selectFromInteractiveWorktreeBrowser,
  selectFromInteractiveWorktreeList,
} from "../../dist/ui.js";
import { FakeTTYStdin, captureConsole, makeChoice, wait, withMutedTerminal, withProperty } from "./helpers.mjs";

function item(label, searchText, modifiedAtMs = Date.now()) {
  return {
    choice: makeChoice({ path: `/tmp/${label}`, label }),
    modifiedAtMs,
    searchText,
  };
}

test("filters worktree list items with fuzzy search", () => {
  const api = item("API work", "api server branch");
  const web = item("Web work", "frontend browser branch");
  assert.deepEqual(filterWorktreeListItems([api, web], ""), [api, web]);
  assert.deepEqual(filterWorktreeListItems([api, web], "api"), [api]);
});

test("formats list rows and choice lists", async (t) => {
  const originalNow = Date.now;
  t.after(() => {
    Date.now = originalNow;
  });
  Date.now = () => 1_000_000_000;

  const active = "/tmp/API work";
  const row = formatWorktreeListRow(item("API work", "api", 1_000_000_000 - 60_000), active, 2);
  assert.equal(row, "1m  * API work");
  assert.equal(ageColumnWidth([item("new", "new", 1_000_000_000), item("old", "old", 1_000_000_000 - 90 * 24 * 60 * 60_000)]), 3);

  const choices = [makeChoice({ path: active, label: "API work" })];
  assert.match(formatChoiceList(choices, active), /\* API work/);
  assert.match(formatNumberedChoiceList(choices, active), /1\. .*API work/);
});

test("prints non-interactive worktree lists", async () => {
  const listItem = item("API work", "api");
  const { logs } = await withProperty(process.stdout, "isTTY", false, async () =>
    captureConsole(() => {
      printWorktreeList([listItem], null);
    }),
  );

  assert.equal(logs.length, 2);
  assert.match(logs[0], /API work/);
  assert.match(logs[1], /\/tmp\/API work/);
  assert.throws(() => printWorktreeList([], null, "missing"), /No worktrees matched 'missing'/);
});

test("selectFromInteractiveWorktreeList handles search, selection, and multi-select", async () => {
  const api = item("API work", "api server");
  const web = item("Web work", "web client");

  const singleInput = new FakeTTYStdin();
  const selected = await withProperty(process, "stdin", singleInput, async () =>
    withMutedTerminal(async () => {
      const promise = selectFromInteractiveWorktreeList({ active: null, items: [api, web], multiple: false });
      await wait(0);
      singleInput.emit("keypress", "w", { name: "w" });
      singleInput.emit("keypress", "\r", { name: "return" });
      return promise;
    }),
  );
  assert.deepEqual(selected.map((choice) => choice.label), ["Web work"]);

  const multiInput = new FakeTTYStdin();
  const checked = await withProperty(process, "stdin", multiInput, async () =>
    withMutedTerminal(async () => {
      const promise = selectFromInteractiveWorktreeList({ active: null, items: [api, web], multiple: true });
      await wait(0);
      multiInput.emit("keypress", "", { name: "tab" });
      multiInput.emit("keypress", "", { name: "down" });
      multiInput.emit("keypress", " ", { name: "space" });
      multiInput.emit("keypress", "\r", { name: "return" });
      return promise;
    }),
  );
  assert.deepEqual(checked.map((choice) => choice.label), ["API work", "Web work"]);
});

test("browseInteractiveWorktreeList handles scrolling, query editing, and exit", async () => {
  const input = new FakeTTYStdin();
  const items = [item("API work", "api server"), item("Web work", "web client"), item("Docs work", "docs")];

  await withProperty(process, "stdin", input, async () =>
    withMutedTerminal(async () => {
      const promise = browseInteractiveWorktreeList({ active: null, items });
      await wait(0);
      input.emit("keypress", "", { name: "down" });
      input.emit("keypress", "", { name: "pagedown" });
      input.emit("keypress", "", { name: "pageup" });
      input.emit("keypress", "", { name: "end" });
      input.emit("keypress", "", { name: "home" });
      input.emit("keypress", "z", { name: "z" });
      input.emit("keypress", "", { name: "backspace" });
      input.emit("keypress", "", { name: "escape" });
      await promise;
    }),
  );
});

test("selectFromInteractiveWorktreeBrowser returns the highlighted row", async () => {
  const input = new FakeTTYStdin();
  const api = item("API work", "api server");
  const web = item("Web work", "web client");

  const selected = await withProperty(process, "stdin", input, async () =>
    withMutedTerminal(async () => {
      const promise = selectFromInteractiveWorktreeBrowser({ active: null, items: [api, web] });
      await wait(0);
      input.emit("keypress", "", { name: "down" });
      input.emit("keypress", "\r", { name: "return" });
      return promise;
    }),
  );

  assert.equal(selected.label, "Web work");
});
