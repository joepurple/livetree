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
  runInteractiveWorktreeSwitcher,
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
  const listItem = item("API work (+1)", "api");
  const { logs } = await withProperty(process.stdout, "isTTY", false, async () =>
    captureConsole(() => {
      printWorktreeList([listItem], null);
    }),
  );

  assert.equal(logs.length, 2);
  assert.match(logs[0], /API work \(\+1\)/);
  assert.match(logs[1], /\/tmp\/API work \(\+1\)/);
  assert.throws(() => printWorktreeList([], null, "missing"), /No worktrees matched 'missing'/);
});

test("runInteractiveWorktreeSwitcher renders selected chat details", async () => {
  const input = new FakeTTYStdin();
  const output = [];
  const work = {
    choice: makeChoice({
      path: "/tmp/api-work",
      label: "Primary Chat (+1)",
      chat: { provider: "codex", id: "thread-primary", title: "Primary Chat" },
      chats: [
        { provider: "codex", id: "thread-primary", title: "Primary Chat" },
        { provider: "claude", id: "thread-review", title: "Review Followup" },
      ],
    }),
    modifiedAtMs: Date.now(),
    searchText: "api",
  };

  await withProperty(process, "stdin", input, async () =>
    withMutedTerminal(async () => {
      const originalWrite = process.stderr.write;
      process.stderr.write = (chunk) => {
        output.push(String(chunk));
        return true;
      };

      try {
        const promise = runInteractiveWorktreeSwitcher({
          active: null,
          items: [work],
          onSelect: () => {},
        });
        await wait(0);
        input.emit("keypress", "\u0003", { ctrl: true, name: "c" });
        await promise;
      } finally {
        process.stderr.write = originalWrite;
      }
    }),
  );

  const rendered = output.join("");
  assert.match(rendered, /> 0m    Primary Chat \(\+1\)/);
  assert.doesNotMatch(rendered, /\| 0m    Primary Chat/);
  assert.match(rendered, /\| 0m    Review Followup/);
  assert.match(rendered, /\|       \/tmp\/api-work/);
});

test("selectFromInteractiveWorktreeList handles selection and multi-select without search", async () => {
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
  assert.deepEqual(selected.map((choice) => choice.label), ["API work"]);

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

test("browseInteractiveWorktreeList handles scrolling and exit without search", async () => {
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

test("runInteractiveWorktreeSwitcher refreshes items while preserving search", async () => {
  const input = new FakeTTYStdin();
  const api = item("API work", "api server");
  const web = item("Web work", "web client");
  const selected = [];
  let refresh;
  let cleanedUp = false;

  await withProperty(process, "stdin", input, async () =>
    withMutedTerminal(async () => {
      const promise = runInteractiveWorktreeSwitcher({
        active: null,
        items: [api],
        onRefresh: (callback) => {
          refresh = callback;
          return () => {
            cleanedUp = true;
          };
        },
        onSelect: (choice) => {
          selected.push(choice.label);
        },
      });

      await wait(0);
      assert.equal(typeof refresh, "function");
      input.emit("keypress", "w", { name: "w" });
      refresh({ active: null, items: [api, web] });
      await wait(0);
      input.emit("keypress", "\r", { name: "return" });
      await wait(0);
      input.emit("keypress", "\u0003", { ctrl: true, name: "c" });
      await promise;
    }),
  );

  assert.deepEqual(selected, ["Web work"]);
  assert.equal(cleanedUp, true);
});
