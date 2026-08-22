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
  chat: {
    provider: "claude" | "codex" | "cursor";
    title: string;
  } | null;
  isMain: boolean;
  modifiedAtMs: number;
  scripts: Script[];
  links: Link[];
};

export type Project = {
  id: string;
  name: string;
  path: string;
  worktrees: Worktree[];
};

export type DashboardState = {
  generatedAtMs: number;
  dashboardVersion?: string;
  tailnet: {
    status: "disabled" | "starting" | "ready" | "unavailable";
    url: string | null;
    error: string | null;
  };
  projects: Project[];
};

export type LogSelection = {
  project: Project;
  worktree: Worktree;
  script: Script;
};
