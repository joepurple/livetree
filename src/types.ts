export type WorktreeRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  prunable: string | null;
};

export type Chat = {
  provider: "claude" | "codex" | "cursor";
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
  stateDir: string;
  choices: WorktreeChoice[];
};

export type DevScript = {
  name: string;
  cmd: string;
  env: Record<string, string>;
  tunnelEnv: Record<string, string>;
  portArg: string | null;
  tunnelPort: "auto" | "app";
};

export type LtConfig = {
  configPath: string;
  name: string;
  initScript: string | null;
  copyFiles: string[];
  devScripts: Record<string, DevScript>;
  links: Record<string, string>;
};

export type ServerEntry = {
  name: string;
  script: string;
  worktree: string;
  pid: number;
  /** Direct application port behind portless. Optional for older state files. */
  appPort?: number;
  url: string;
  envFingerprint: string;
  tunneled: boolean;
  /** Read only for migration from pre-0.2 development builds. */
  env?: Record<string, string>;
  startedAtMs: number;
  managed: boolean;
  logPath: string | null;
};

export type TunnelEntry = {
  name: string;
  script: string;
  worktree: string;
  pid: number;
  httpsPort?: number;
  url: string;
  startedAtMs: number;
};

export type ModifiedWorktreeChoice = {
  choice: WorktreeChoice;
  modifiedAtMs: number;
};

export type CreatedWorktreeChoice = {
  choice: WorktreeChoice;
  createdAtMs: number;
};
