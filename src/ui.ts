import readline from "node:readline";
import fuzzysort from "fuzzysort";
import { CliError } from "./errors.js";
import { samePath } from "./path-utils.js";
import {
  dim,
  dropLastCharacter,
  enterAlternateScreen,
  escapeControlCharacters,
  formatRelativeAge,
  leaveAlternateScreen,
  printableKeypressValue,
  reverse,
  writeFullscreenBlock,
  writeInlineBlock,
} from "./terminal.js";
import type { WorktreeChoice, WorktreeListItem } from "./types.js";
import { worktreeListItemsModifiedNewestFirst } from "./worktrees.js";

type InteractiveWorktreeListOptions = {
  active: string | null;
  initialQuery?: string;
  items: WorktreeListItem[];
  multiple: boolean;
};

type InteractiveWorktreeBrowserOptions = {
  active: string | null;
  initialQuery?: string;
  items: WorktreeListItem[];
};

type InteractiveWorktreeSwitcherOptions = {
  active: string | null;
  initialQuery?: string;
  items: WorktreeListItem[];
  onSelect: (choice: WorktreeChoice) => void | Promise<void>;
};

type InteractiveWorktreeListRenderOptions = {
  active: string | null;
  ageWidth: number;
  checkedPaths: Set<string>;
  filtered: WorktreeListItem[];
  items: WorktreeListItem[];
  multiple: boolean;
  query: string;
  selectedIndex: number;
};

type InteractiveWorktreeBrowserRenderOptions = {
  active: string | null;
  ageWidth: number;
  filtered: WorktreeListItem[];
  items: WorktreeListItem[];
  query: string;
  scrollOffset: number;
  selectedIndex?: number;
};

type InteractiveWorktreeSwitcherRenderOptions = {
  active: string | null;
  ageWidth: number;
  filtered: WorktreeListItem[];
  items: WorktreeListItem[];
  query: string;
  selectedIndex: number;
  status: string | null;
};

export function printWorktreeList(items: WorktreeListItem[], active: string | null, query = ""): void {
  const ageWidth = ageColumnWidth(items);

  if (items.length === 0) {
    throw new CliError(`No worktrees matched '${query.trim()}'.`);
  }

  for (const item of items) {
    console.log(formatWorktreeListRow(item, active, ageWidth));
    console.log(`    ${dim(item.choice.path, process.stdout)}`);
  }
}

export function browseInteractiveWorktreeList(options: InteractiveWorktreeBrowserOptions): Promise<void> {
  const { active, initialQuery = "", items } = options;
  let query = initialQuery.trim();
  let scrollOffset = 0;
  const ageWidth = ageColumnWidth(items);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let renderedLines = 0;

    const cleanup = (): void => {
      stdin.off("keypress", onKeypress);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const filteredItems = (): WorktreeListItem[] => filterWorktreeListItems(items, query);

    const clampScroll = (filteredLength: number): void => {
      const visibleCount = visibleWorktreeBrowserItemCount(filteredLength);
      const maxOffset = Math.max(0, filteredLength - visibleCount);
      scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
    };

    const render = (): void => {
      const filtered = filteredItems();
      clampScroll(filtered.length);
      const lines = formatInteractiveWorktreeBrowser({
        active,
        ageWidth,
        filtered,
        items,
        query,
        scrollOffset,
      });

      writeInlineBlock(lines, renderedLines);
      renderedLines = lines.length;
    };

    const finish = (): void => {
      cleanup();
      resolve();
    };

    const cancel = (): void => {
      cleanup();
      process.stderr.write("Canceled.\n");
      reject(new CliError("Canceled."));
    };

    const resetQueryScroll = (): void => {
      scrollOffset = 0;
      render();
    };

    const moveScroll = (delta: number): void => {
      scrollOffset += delta;
      render();
    };

    const pageScroll = (direction: -1 | 1): void => {
      const filtered = filteredItems();
      const visibleCount = visibleWorktreeBrowserItemCount(filtered.length);
      moveScroll(direction * visibleCount);
    };

    const onKeypress = (value: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }

      switch (key.name ?? value) {
        case "return":
        case "enter":
          finish();
          return;
        case "escape":
          if (query.length > 0) {
            query = "";
            resetQueryScroll();
          } else {
            finish();
          }
          return;
        case "backspace":
          if (query.length > 0) {
            query = dropLastCharacter(query);
            resetQueryScroll();
          }
          return;
        case "up":
          moveScroll(-1);
          return;
        case "down":
          moveScroll(1);
          return;
        case "pageup":
          pageScroll(-1);
          return;
        case "pagedown":
          pageScroll(1);
          return;
        case "home":
          scrollOffset = 0;
          render();
          return;
        case "end": {
          const filtered = filteredItems();
          scrollOffset = filtered.length;
          render();
          return;
        }
        default:
          break;
      }

      const typed = printableKeypressValue(value, key);
      if (typed !== null) {
        query += typed;
        resetQueryScroll();
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

export function selectFromInteractiveWorktreeBrowser(options: InteractiveWorktreeBrowserOptions): Promise<WorktreeChoice> {
  const { active, initialQuery = "", items } = options;
  let query = initialQuery.trim();
  let selectedIndex = query ? 0 : Math.max(0, items.findIndex((item) => active && samePath(item.choice.path, active)));
  const ageWidth = ageColumnWidth(items);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let renderedLines = 0;

    const cleanup = (): void => {
      stdin.off("keypress", onKeypress);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const filteredItems = (): WorktreeListItem[] => filterWorktreeListItems(items, query);

    const clampSelection = (filteredLength: number): void => {
      if (filteredLength === 0) {
        selectedIndex = 0;
      } else if (selectedIndex >= filteredLength) {
        selectedIndex = filteredLength - 1;
      } else if (selectedIndex < 0) {
        selectedIndex = 0;
      }
    };

    const render = (): void => {
      const filtered = filteredItems();
      clampSelection(filtered.length);
      const lines = formatInteractiveWorktreeBrowser({
        active,
        ageWidth,
        filtered,
        items,
        query,
        scrollOffset: selectedIndex,
        selectedIndex,
      });

      writeInlineBlock(lines, renderedLines);
      renderedLines = lines.length;
    };

    const finish = (): void => {
      const filtered = filteredItems();
      clampSelection(filtered.length);
      const item = filtered[selectedIndex];
      if (!item) {
        render();
        return;
      }

      cleanup();
      resolve(item.choice);
    };

    const cancel = (): void => {
      cleanup();
      process.stderr.write("Canceled.\n");
      reject(new CliError("Canceled."));
    };

    const moveSelection = (delta: number): void => {
      const filtered = filteredItems();
      if (filtered.length === 0) {
        render();
        return;
      }

      selectedIndex = (selectedIndex + delta + filtered.length) % filtered.length;
      render();
    };

    const pageSelection = (direction: -1 | 1): void => {
      const filtered = filteredItems();
      const visibleCount = visibleWorktreeBrowserItemCount(filtered.length);
      selectedIndex += direction * visibleCount;
      render();
    };

    const resetQuerySelection = (): void => {
      selectedIndex = 0;
      render();
    };

    const onKeypress = (value: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }

      switch (key.name ?? value) {
        case "return":
        case "enter":
          finish();
          return;
        case "escape":
          if (query.length > 0) {
            query = "";
            resetQuerySelection();
          } else {
            cancel();
          }
          return;
        case "backspace":
          if (query.length > 0) {
            query = dropLastCharacter(query);
            resetQuerySelection();
          }
          return;
        case "up":
          moveSelection(-1);
          return;
        case "down":
          moveSelection(1);
          return;
        case "pageup":
          pageSelection(-1);
          return;
        case "pagedown":
          pageSelection(1);
          return;
        case "home":
          selectedIndex = 0;
          render();
          return;
        case "end": {
          const filtered = filteredItems();
          selectedIndex = filtered.length - 1;
          render();
          return;
        }
        default:
          break;
      }

      const typed = printableKeypressValue(value, key);
      if (typed !== null) {
        query += typed;
        resetQuerySelection();
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

export function runInteractiveWorktreeSwitcher(options: InteractiveWorktreeSwitcherOptions): Promise<void> {
  const { initialQuery = "", items, onSelect } = options;
  let active = options.active;
  let query = initialQuery.trim();
  let selectedIndex = query ? 0 : Math.max(0, items.findIndex((item) => active && samePath(item.choice.path, active)));
  let status: string | null = null;
  const ageWidth = ageColumnWidth(items);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    let settled = false;

    const filteredItems = (): WorktreeListItem[] => filterWorktreeListItems(items, query);

    const clampSelection = (filteredLength: number): void => {
      if (filteredLength === 0) {
        selectedIndex = 0;
      } else if (selectedIndex >= filteredLength) {
        selectedIndex = filteredLength - 1;
      } else if (selectedIndex < 0) {
        selectedIndex = 0;
      }
    };

    const render = (): void => {
      const filtered = filteredItems();
      clampSelection(filtered.length);
      const lines = formatInteractiveWorktreeSwitcher({
        active,
        ageWidth,
        filtered,
        items,
        query,
        selectedIndex,
        status,
      });

      writeFullscreenBlock(lines);
    };

    const cleanup = (): void => {
      stdin.off("keypress", onKeypress);
      stderr.off("resize", render);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
      leaveAlternateScreen();
    };

    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const moveSelection = (delta: number): void => {
      const filtered = filteredItems();
      if (filtered.length === 0) {
        render();
        return;
      }

      selectedIndex = (selectedIndex + delta + filtered.length) % filtered.length;
      render();
    };

    const pageSelection = (direction: -1 | 1): void => {
      const filtered = filteredItems();
      const visibleCount = visibleWorktreeSwitcherItemCount(filtered.length);
      selectedIndex += direction * visibleCount;
      render();
    };

    const resetQuerySelection = (): void => {
      selectedIndex = 0;
      status = null;
      render();
    };

    const switchToSelected = (): void => {
      const filtered = filteredItems();
      clampSelection(filtered.length);
      const item = filtered[selectedIndex];
      if (!item) {
        render();
        return;
      }

      try {
        const result = onSelect(item.choice);
        Promise.resolve(result).then(
          () => {
            if (settled) {
              return;
            }

            active = item.choice.path;
            status = `Active: ${item.choice.label}`;
            render();
          },
          (error: unknown) => fail(error),
        );
      } catch (error) {
        fail(error);
      }
    };

    const onKeypress = (value: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        finish();
        return;
      }

      switch (key.name ?? value) {
        case "return":
        case "enter":
          switchToSelected();
          return;
        case "escape":
          if (query.length > 0) {
            query = "";
            resetQuerySelection();
          }
          return;
        case "backspace":
          if (query.length > 0) {
            query = dropLastCharacter(query);
            resetQuerySelection();
          }
          return;
        case "up":
          moveSelection(-1);
          return;
        case "down":
          moveSelection(1);
          return;
        case "pageup":
          pageSelection(-1);
          return;
        case "pagedown":
          pageSelection(1);
          return;
        case "home":
          selectedIndex = 0;
          render();
          return;
        case "end": {
          const filtered = filteredItems();
          selectedIndex = filtered.length - 1;
          render();
          return;
        }
        default:
          break;
      }

      const typed = printableKeypressValue(value, key);
      if (typed !== null) {
        query += typed;
        resetQuerySelection();
      }
    };

    enterAlternateScreen();
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    stderr.on("resize", render);
    render();
  });
}

export function formatChoiceList(choices: WorktreeChoice[], active: string | null): string {
  const items = worktreeListItemsModifiedNewestFirst(choices);
  const ageWidth = ageColumnWidth(items);
  return items.map((item) => `  ${formatWorktreeListRow(item, active, ageWidth)}`).join("\n");
}

export function formatNumberedChoiceList(choices: WorktreeChoice[], active: string | null): string {
  const items = worktreeListItemsModifiedNewestFirst(choices);
  const ageWidth = ageColumnWidth(items);
  const numberWidth = Math.max(String(items.length).length, 1);
  return items.map((item, index) => `  ${String(index + 1).padStart(numberWidth)}. ${formatWorktreeListRow(item, active, ageWidth)}`).join("\n");
}

export function selectFromInteractiveWorktreeList(options: InteractiveWorktreeListOptions): Promise<WorktreeChoice[]> {
  const { active, initialQuery = "", items, multiple } = options;
  let query = initialQuery.trim();
  let selectedIndex = query ? 0 : Math.max(0, items.findIndex((item) => active && samePath(item.choice.path, active)));
  const checkedPaths = new Set<string>();
  const ageWidth = ageColumnWidth(items);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let renderedLines = 0;

    const cleanup = (): void => {
      stdin.off("keypress", onKeypress);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const filteredItems = (): WorktreeListItem[] => filterWorktreeListItems(items, query);

    const clampSelection = (filteredLength: number): void => {
      if (filteredLength === 0) {
        selectedIndex = 0;
      } else if (selectedIndex >= filteredLength) {
        selectedIndex = filteredLength - 1;
      } else if (selectedIndex < 0) {
        selectedIndex = 0;
      }
    };

    const render = (): void => {
      const filtered = filteredItems();
      clampSelection(filtered.length);
      const lines = formatInteractiveWorktreeList({
        active,
        ageWidth,
        checkedPaths,
        filtered,
        items,
        multiple,
        query,
        selectedIndex,
      });

      writeInlineBlock(lines, renderedLines);
      renderedLines = lines.length;
    };

    const finish = (): void => {
      const filtered = filteredItems();
      clampSelection(filtered.length);
      if (!multiple && filtered.length === 0) {
        render();
        return;
      }

      cleanup();
      if (multiple) {
        resolve(items.filter((item) => checkedPaths.has(item.choice.path)).map((item) => item.choice));
        return;
      }

      resolve([filtered[selectedIndex]!.choice]);
    };

    const cancel = (): void => {
      cleanup();
      process.stderr.write("Canceled.\n");
      reject(new CliError("Canceled."));
    };

    const moveSelection = (delta: number): void => {
      const filtered = filteredItems();
      if (filtered.length === 0) {
        render();
        return;
      }

      selectedIndex = (selectedIndex + delta + filtered.length) % filtered.length;
      render();
    };

    const resetQuerySelection = (): void => {
      selectedIndex = 0;
      render();
    };

    const toggleSelected = (): void => {
      if (!multiple) {
        return;
      }

      const filtered = filteredItems();
      clampSelection(filtered.length);
      const item = filtered[selectedIndex];
      if (!item) {
        render();
        return;
      }

      if (checkedPaths.has(item.choice.path)) {
        checkedPaths.delete(item.choice.path);
      } else {
        checkedPaths.add(item.choice.path);
      }
      render();
    };

    const onKeypress = (value: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        cancel();
        return;
      }

      switch (key.name ?? value) {
        case "return":
        case "enter":
          finish();
          return;
        case "escape":
          if (query.length > 0) {
            query = "";
            resetQuerySelection();
          } else {
            cancel();
          }
          return;
        case "backspace":
          if (query.length > 0) {
            query = dropLastCharacter(query);
            resetQuerySelection();
          }
          return;
        case "up":
          moveSelection(-1);
          return;
        case "down":
          moveSelection(1);
          return;
        case "tab":
          toggleSelected();
          return;
        case "space":
          if (multiple) {
            toggleSelected();
            return;
          }
          break;
        default:
          break;
      }

      const typed = printableKeypressValue(value, key);
      if (typed !== null) {
        query += typed;
        resetQuerySelection();
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    render();
  });
}

export function filterWorktreeListItems(items: WorktreeListItem[], query: string): WorktreeListItem[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return items;
  }

  return fuzzysort.go(trimmed, items, { key: "searchText" }).map((result) => result.obj);
}

export function formatWorktreeListRow(item: WorktreeListItem, active: string | null, ageWidth: number): string {
  return `${formatRelativeAge(item.modifiedAtMs).padStart(ageWidth)}  ${formatChoiceLabel(item.choice, active)}`;
}

export function ageColumnWidth(items: WorktreeListItem[]): number {
  return Math.max(...items.map((item) => formatRelativeAge(item.modifiedAtMs).length), 1);
}

function formatInteractiveWorktreeList(options: InteractiveWorktreeListRenderOptions): string[] {
  const { active, ageWidth, checkedPaths, filtered, items, multiple, query, selectedIndex } = options;
  const lines = [formatSearchBox(query, selectedIndex, filtered.length, items.length, multiple ? checkedPaths.size : null)];

  if (filtered.length === 0) {
    lines.push("  No matches");
    return lines;
  }

  const [start, end] = visibleWorktreePickerRange(filtered.length, selectedIndex);
  for (let index = start; index < end; index += 1) {
    const item = filtered[index]!;
    const checkbox = multiple ? `${checkedPaths.has(item.choice.path) ? "[x]" : "[ ]"} ` : "";
    const line = `${index === selectedIndex ? "> " : "  "}${checkbox}${formatWorktreeListRow(item, active, ageWidth)}`;
    lines.push(index === selectedIndex ? reverse(line) : line);
  }

  return lines;
}

function formatInteractiveWorktreeBrowser(options: InteractiveWorktreeBrowserRenderOptions): string[] {
  const { active, ageWidth, filtered, items, query, scrollOffset, selectedIndex } = options;
  const visibleCount = Math.min(visibleWorktreeBrowserItemCount(filtered.length), filtered.length);
  const lines = [formatBrowseSearchBox(query, filtered.length, items.length, scrollOffset, visibleCount)];

  if (filtered.length === 0) {
    lines.push("  No matches");
    return lines;
  }

  const [start, end] = visibleWorktreeBrowserRange(filtered.length, scrollOffset);
  for (let index = start; index < end; index += 1) {
    const item = filtered[index]!;
    const selected = index === selectedIndex;
    const row = `${selected ? "> " : "  "}${formatWorktreeListRow(item, active, ageWidth)}`;
    const pathRow = `    ${dim(item.choice.path, process.stderr)}`;
    lines.push(selected ? reverse(row) : row);
    lines.push(selected ? reverse(pathRow) : pathRow);
  }

  return lines;
}

function formatInteractiveWorktreeSwitcher(options: InteractiveWorktreeSwitcherRenderOptions): string[] {
  const { active, ageWidth, filtered, items, query, selectedIndex, status } = options;
  const lines = ["lt", formatSearchBox(query, selectedIndex, filtered.length, items.length, null)];
  lines.push(dim(status ?? formatSwitcherIdleStatus(active, items), process.stderr));

  if (filtered.length === 0) {
    lines.push("");
    lines.push("  No matches");
    return lines;
  }

  const [start, end] = visibleWorktreeSwitcherRange(filtered.length, selectedIndex);
  for (let index = start; index < end; index += 1) {
    const item = filtered[index]!;
    const line = `${index === selectedIndex ? "> " : "  "}${formatWorktreeListRow(item, active, ageWidth)}`;
    lines.push(index === selectedIndex ? reverse(line) : line);
  }

  return lines;
}

function visibleWorktreePickerRange(itemCount: number, selectedIndex: number): [number, number] {
  const terminalRows = process.stderr.rows;
  const maxVisible = Math.max(1, Math.min(itemCount, typeof terminalRows === "number" && terminalRows > 1 ? terminalRows - 1 : itemCount));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), itemCount - maxVisible));
  return [start, start + maxVisible];
}

function visibleWorktreeBrowserRange(itemCount: number, scrollOffset: number): [number, number] {
  const maxVisible = visibleWorktreeBrowserItemCount(itemCount);
  const start = Math.max(0, Math.min(scrollOffset, itemCount - maxVisible));
  return [start, start + maxVisible];
}

function visibleWorktreeBrowserItemCount(itemCount: number): number {
  const terminalRows = process.stderr.rows;
  const availableRows = typeof terminalRows === "number" && terminalRows > 1 ? terminalRows - 1 : itemCount * 2;
  return Math.max(1, Math.min(itemCount, Math.floor(availableRows / 2)));
}

function visibleWorktreeSwitcherRange(itemCount: number, selectedIndex: number): [number, number] {
  const maxVisible = visibleWorktreeSwitcherItemCount(itemCount);
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), itemCount - maxVisible));
  return [start, start + maxVisible];
}

function visibleWorktreeSwitcherItemCount(itemCount: number): number {
  const terminalRows = process.stderr.rows;
  const reservedRows = 3;
  const availableRows = typeof terminalRows === "number" && terminalRows > reservedRows ? terminalRows - reservedRows : itemCount;
  return Math.max(1, Math.min(itemCount, availableRows));
}

function formatSearchBox(query: string, selectedIndex: number, filteredCount: number, totalCount: number, checkedCount: number | null): string {
  const selectedNumber = filteredCount === 0 ? 0 : selectedIndex + 1;
  const count = filteredCount === totalCount ? `${selectedNumber}/${filteredCount}` : `${selectedNumber}/${filteredCount} of ${totalCount}`;
  const checked = checkedCount === null ? "" : `, ${checkedCount} selected`;
  return `Search: [${escapeControlCharacters(query)}] ${count}${checked}`;
}

function formatBrowseSearchBox(query: string, filteredCount: number, totalCount: number, scrollOffset: number, visibleCount: number): string {
  const visibleEnd = Math.min(scrollOffset + visibleCount, filteredCount);
  const filteredRange = filteredCount === 0 ? "0" : visibleCount >= filteredCount ? `${filteredCount}` : `${scrollOffset + 1}-${visibleEnd}/${filteredCount}`;
  const count = filteredCount === totalCount ? filteredRange : `${filteredRange} of ${totalCount}`;
  return `Search: [${escapeControlCharacters(query)}] ${count} worktree${totalCount === 1 ? "" : "s"}`;
}

function formatSwitcherIdleStatus(active: string | null, items: WorktreeListItem[]): string {
  const activeItem = active ? items.find((item) => samePath(item.choice.path, active)) : null;
  const activeLabel = activeItem ? `Active: ${activeItem.choice.label}. ` : "";
  return `${activeLabel}Enter switches, Esc clears search, Ctrl-C exits.`;
}

function formatChoiceLabel(choice: WorktreeChoice, active: string | null): string {
  const marker = active && samePath(choice.path, active) ? "*" : " ";
  return `${marker} ${choice.label}`;
}
