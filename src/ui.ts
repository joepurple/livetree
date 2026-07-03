import readline from "node:readline";
import fuzzysort from "fuzzysort";
import { CliError } from "./errors.js";
import { samePath } from "./path-utils.js";
import { dim, dropLastCharacter, escapeControlCharacters, formatRelativeAge, printableKeypressValue, reverse, writeInlineBlock } from "./terminal.js";
import type { WorktreeChoice, WorktreeListItem } from "./types.js";
import { worktreeListItemsModifiedNewestFirst } from "./worktrees.js";

type InteractiveWorktreeListOptions = {
  active: string | null;
  initialQuery?: string;
  items: WorktreeListItem[];
  multiple: boolean;
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

export function printWorktreeList(items: WorktreeListItem[], active: string | null, query = ""): void {
  const ageWidth = ageColumnWidth(items);

  if (items.length === 0) {
    throw new CliError(`No worktrees matched '${query.trim()}'.`);
  }

  for (const item of items) {
    console.log(formatWorktreeListRow(item, active, ageWidth));
    console.log(`    ${dim(item.choice.path)}`);
  }
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

function visibleWorktreePickerRange(itemCount: number, selectedIndex: number): [number, number] {
  const terminalRows = process.stderr.rows;
  const maxVisible = Math.max(1, Math.min(itemCount, typeof terminalRows === "number" && terminalRows > 1 ? terminalRows - 1 : itemCount));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), itemCount - maxVisible));
  return [start, start + maxVisible];
}

function formatSearchBox(query: string, selectedIndex: number, filteredCount: number, totalCount: number, checkedCount: number | null): string {
  const selectedNumber = filteredCount === 0 ? 0 : selectedIndex + 1;
  const count = filteredCount === totalCount ? `${selectedNumber}/${filteredCount}` : `${selectedNumber}/${filteredCount} of ${totalCount}`;
  const checked = checkedCount === null ? "" : `, ${checkedCount} selected`;
  return `Search: [${escapeControlCharacters(query)}] ${count}${checked}`;
}

function formatChoiceLabel(choice: WorktreeChoice, active: string | null): string {
  const marker = active && samePath(choice.path, active) ? "*" : " ";
  return `${marker} ${choice.label}`;
}
