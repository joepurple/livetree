export type Script = {
  script: string;
  name: string;
  url: string;
  running: boolean;
  healthy: boolean;
  pid: number | null;
  startedAtMs: number | null;
  managed: boolean;
  logPath: string | null;
  tunnelUrl: string | null;
};

export type Link = {
  name: string;
  url: string | null;
  available: boolean;
  error?: string;
  qr: string | null;
};

export type Worktree = {
  path: string;
  branch: string | null;
  ref: string | null;
  label: string;
  isMain: boolean;
  modifiedAtMs: number;
  scripts: Script[];
  links: Link[];
};

export type DashboardState = {
  project: string;
  generatedAtMs: number;
  worktrees: Worktree[];
};

export type LogSelection = {
  worktree: Worktree;
  script: Script;
};
