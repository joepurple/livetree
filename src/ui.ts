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
  items: WorktreeListItem[];
  multiple: boolean;
};

type InteractiveWorktreeBrowserOptions = {
  active: string | null;
  items: WorktreeListItem[];
};

type InteractiveWorktreeSwitcherOptions = {
  active: string | null;
  initialQuery?: string;
  items: WorktreeListItem[];
  onRefresh?: (refresh: (snapshot: WorktreeSwitcherSnapshot) => void) => (() => void) | void;
  onSelect: (choice: WorktreeChoice) => void | Promise<void>;
};

export type WorktreeSwitcherSnapshot = {
  active: string | null;
  items: WorktreeListItem[];
};

type InteractiveWorktreeListRenderOptions = {
  active: string | null;
  ageWidth: number;
  checkedPaths: Set<string>;
  items: WorktreeListItem[];
  multiple: boolean;
  selectedIndex: number;
};

type InteractiveWorktreeBrowserRenderOptions = {
  active: string | null;
  ageWidth: number;
  items: WorktreeListItem[];
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
  const { active, items } = options;
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

    const clampScroll = (): void => {
      const visibleCount = visibleWorktreeBrowserItemCount(items.length);
      const maxOffset = Math.max(0, items.length - visibleCount);
      scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
    };

    const render = (): void => {
      clampScroll();
      const lines = formatInteractiveWorktreeBrowser({
        active,
        ageWidth,
        items,
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

    const moveScroll = (delta: number): void => {
      scrollOffset += delta;
      render();
    };

    const pageScroll = (direction: -1 | 1): void => {
      const visibleCount = visibleWorktreeBrowserItemCount(items.length);
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
          finish();
          return;
        case "backspace":
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
          scrollOffset = items.length;
          render();
          return;
        }
        default:
          return;
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
  const { active, items } = options;
  let selectedIndex = Math.max(0, items.findIndex((item) => active && samePath(item.choice.path, active)));
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

    const clampSelection = (): void => {
      if (items.length === 0) {
        selectedIndex = 0;
      } else if (selectedIndex >= items.length) {
        selectedIndex = items.length - 1;
      } else if (selectedIndex < 0) {
        selectedIndex = 0;
      }
    };

    const render = (): void => {
      clampSelection();
      const lines = formatInteractiveWorktreeBrowser({
        active,
        ageWidth,
        items,
        scrollOffset: selectedIndex,
        selectedIndex,
      });

      writeInlineBlock(lines, renderedLines);
      renderedLines = lines.length;
    };

    const finish = (): void => {
      clampSelection();
      const item = items[selectedIndex];
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
      if (items.length === 0) {
        render();
        return;
      }

      selectedIndex = (selectedIndex + delta + items.length) % items.length;
      render();
    };

    const pageSelection = (direction: -1 | 1): void => {
      const visibleCount = visibleWorktreeBrowserItemCount(items.length);
      selectedIndex += direction * visibleCount;
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
          cancel();
          return;
        case "backspace":
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
          selectedIndex = items.length - 1;
          render();
          return;
        }
        default:
          return;
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
  const { initialQuery = "", onRefresh, onSelect } = options;
  let active = options.active;
  let items = options.items;
  let query = initialQuery.trim();
  let selectedIndex = query ? 0 : Math.max(0, items.findIndex((item) => active && samePath(item.choice.path, active)));
  let status: string | null = null;
  let ageWidth = ageColumnWidth(items);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    let settled = false;
    let stopRefresh: (() => void) | undefined;

    const filteredItems = createFilteredItemsGetter(() => items, () => query);

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
      stopRefresh?.();
      stopRefresh = undefined;
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

    const refreshItems = (snapshot: WorktreeSwitcherSnapshot): void => {
      if (settled) {
        return;
      }

      const selectedPath = filteredItems()[selectedIndex]?.choice.path ?? null;
      active = snapshot.active;
      items = snapshot.items;
      ageWidth = ageColumnWidth(items);
      status = null;

      if (selectedPath) {
        const refreshedSelectedIndex = filteredItems().findIndex((item) => samePath(item.choice.path, selectedPath));
        if (refreshedSelectedIndex >= 0) {
          selectedIndex = refreshedSelectedIndex;
        }
      }

      render();
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
    try {
      stopRefresh = onRefresh?.(refreshItems) ?? undefined;
    } catch (error) {
      fail(error);
      return;
    }
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
  const { active, items, multiple } = options;
  let selectedIndex = Math.max(0, items.findIndex((item) => active && samePath(item.choice.path, active)));
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

    const clampSelection = (): void => {
      if (items.length === 0) {
        selectedIndex = 0;
      } else if (selectedIndex >= items.length) {
        selectedIndex = items.length - 1;
      } else if (selectedIndex < 0) {
        selectedIndex = 0;
      }
    };

    const render = (): void => {
      clampSelection();
      const lines = formatInteractiveWorktreeList({
        active,
        ageWidth,
        checkedPaths,
        items,
        multiple,
        selectedIndex,
      });

      writeInlineBlock(lines, renderedLines);
      renderedLines = lines.length;
    };

    const finish = (): void => {
      clampSelection();
      if (!multiple && items.length === 0) {
        render();
        return;
      }

      cleanup();
      if (multiple) {
        resolve(items.filter((item) => checkedPaths.has(item.choice.path)).map((item) => item.choice));
        return;
      }

      resolve([items[selectedIndex]!.choice]);
    };

    const cancel = (): void => {
      cleanup();
      process.stderr.write("Canceled.\n");
      reject(new CliError("Canceled."));
    };

    const moveSelection = (delta: number): void => {
      if (items.length === 0) {
        render();
        return;
      }

      selectedIndex = (selectedIndex + delta + items.length) % items.length;
      render();
    };

    const toggleSelected = (): void => {
      if (!multiple) {
        return;
      }

      clampSelection();
      const item = items[selectedIndex];
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
          cancel();
          return;
        case "backspace":
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
          return;
        default:
          return;
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

function createFilteredItemsGetter(items: () => WorktreeListItem[], query: () => string): () => WorktreeListItem[] {
  let cachedSource: WorktreeListItem[] | null = null;
  let cachedQuery: string | null = null;
  let cachedItems: WorktreeListItem[] = [];

  return () => {
    const currentItems = items();
    const currentQuery = query();
    if (currentItems !== cachedSource || currentQuery !== cachedQuery) {
      cachedSource = currentItems;
      cachedQuery = currentQuery;
      cachedItems = filterWorktreeListItems(currentItems, currentQuery);
    }

    return cachedItems;
  };
}

export function formatWorktreeListRow(item: WorktreeListItem, active: string | null, ageWidth: number): string {
  return `${formatRelativeAge(item.modifiedAtMs).padStart(ageWidth)}  ${formatChoiceLabel(item.choice, active)}`;
}

export function ageColumnWidth(items: WorktreeListItem[]): number {
  return Math.max(...items.map((item) => formatRelativeAge(item.modifiedAtMs).length), 1);
}

function formatInteractiveWorktreeList(options: InteractiveWorktreeListRenderOptions): string[] {
  const { active, ageWidth, checkedPaths, items, multiple, selectedIndex } = options;
  const lines = [formatPickerHeader(selectedIndex, items.length, multiple ? checkedPaths.size : null)];

  if (items.length === 0) {
    lines.push("  No worktrees");
    return lines;
  }

  const [start, end] = visibleWorktreePickerRange(items.length, selectedIndex);
  for (let index = start; index < end; index += 1) {
    const item = items[index]!;
    const checkbox = multiple ? `${checkedPaths.has(item.choice.path) ? "[x]" : "[ ]"} ` : "";
    const line = `${index === selectedIndex ? "> " : "  "}${checkbox}${formatWorktreeListRow(item, active, ageWidth)}`;
    lines.push(index === selectedIndex ? reverse(line) : line);
  }

  return lines;
}

function formatInteractiveWorktreeBrowser(options: InteractiveWorktreeBrowserRenderOptions): string[] {
  const { active, ageWidth, items, scrollOffset, selectedIndex } = options;
  const visibleCount = Math.min(visibleWorktreeBrowserItemCount(items.length), items.length);
  const lines = [formatBrowseHeader(items.length, scrollOffset, visibleCount)];

  if (items.length === 0) {
    lines.push("  No worktrees");
    return lines;
  }

  const [start, end] = visibleWorktreeBrowserRange(items.length, scrollOffset);
  for (let index = start; index < end; index += 1) {
    const item = items[index]!;
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

function formatPickerHeader(selectedIndex: number, totalCount: number, checkedCount: number | null): string {
  const selectedNumber = totalCount === 0 ? 0 : selectedIndex + 1;
  const checked = checkedCount === null ? "" : `, ${checkedCount} selected`;
  return `Worktrees: ${selectedNumber}/${totalCount}${checked}`;
}

function formatBrowseHeader(totalCount: number, scrollOffset: number, visibleCount: number): string {
  const visibleEnd = Math.min(scrollOffset + visibleCount, totalCount);
  const range = totalCount === 0 ? "0" : visibleCount >= totalCount ? `${totalCount}` : `${scrollOffset + 1}-${visibleEnd}/${totalCount}`;
  return `Worktrees: ${range}`;
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
