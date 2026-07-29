export type WorktreeRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  prunable: string | null;
};

export type Chat = {
  provider: "claude" | "codex";
  id: string;
  title: string;
  updatedAtMs?: number;
};

export type WorktreeChoice = WorktreeRecord & {
  label: string;
  ref: string | null;
  chat: Chat | null;
  chats: Chat[];
  isMain: boolean;
  lastCommitAtMs?: number | null;
};

export type ProjectContext = {
  cwd: string;
  currentRoot: string;
  commonDir: string;
  mainRoot: string;
  liveDir: string;
  srcLink: string;
  stateFile: string;
  sourceOverride?: string;
  choices: WorktreeChoice[];
};

export type LtConfig = {
  initScript: string | null;
  copyFiles: string[];
  runScripts: Record<string, string>;
  configPath: string;
};

export type RunOptions = {
  scriptName: string | null;
  scriptArgs: string[];
};

export type RunConfiguredScriptOptions = {
  shortcut?: boolean;
};

export type LivetreeSourceSnapshot = {
  source: string;
  key: string;
};

export type ModifiedWorktreeChoice = {
  choice: WorktreeChoice;
  modifiedAtMs: number;
};

export type WorktreeListItem = ModifiedWorktreeChoice & {
  searchText: string;
};

export type CreatedWorktreeChoice = {
  choice: WorktreeChoice;
  createdAtMs: number;
};
