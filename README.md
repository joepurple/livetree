# treeswitch

`treeswitch` switches a stable runner symlink for a Git project:

```text
<main-worktree>/.live-tree/src -> <selected-worktree>
```

Run it from any worktree that belongs to the project.

```sh
treeswitch
treeswitch <selector>
treeswitch init
treeswitch run <script-name>
treeswitch run --static <script-name>
treeswitch rm
```

`tsw` is installed as a shorthand for the same command.

With no selector, `treeswitch` opens a small picker. With a selector, it matches a worktree path, basename, branch name, commit hash prefix, Codex thread id prefix, or Codex chat title fragment.

Use `treeswitch init` to choose a worktree, newest-created first, copy any configured files from the main worktree into it, and run the project init script in that worktree. Define init behavior in `.tswconf` at the main worktree root:

```yaml
init:
  copy:
    - modules/api/.env
    - modules/mobile/.env.local
  script: pnpm install
```

Copy paths are relative to the main worktree root. Missing copy files are reported and skipped.

Multiline scripts are supported:

```yaml
init:
  copy:
    - modules/api/.env
  script: |
    corepack enable
    pnpm install
```

The shorthand forms `init: pnpm install`, `initScript: pnpm install`, and `scripts:` with an indented `init:` value are also supported.

Define reusable live-tree commands under `run`:

```yaml
run:
  api: cd src/modules/api && pnpm start
  web: cd src/modules/web && pnpm start
  mobile: cd src/modules/mobile && pnpm start
```

Run them with `treeswitch run api` or `tsw run api`. Run scripts start in `<main-worktree>/.live-tree`, so paths should go through `src/...`. By default, `treeswitch` watches `.live-tree/src`; when you switch the active worktree, it stops the current process tree and starts the script again against the new target. Add `--static` to run once without watching or restarting:

```sh
tsw run --static web
```

Use `treeswitch rm`, `treeswitch remove`, or `treeswitch delete` to select linked worktrees to remove. The main worktree is not removable through this command, and selected worktrees are shown again with their paths before removal. Confirm with `y`; anything else cancels. If Git refuses because a selected worktree has modified or untracked files, `treeswitch` asks before retrying that worktree with `--force`. If Git reports a stale/prunable worktree whose `.git` file is already missing, `treeswitch` prunes the stale Git metadata and asks before deleting the leftover directory.

Install locally while developing:

```sh
npm install
npm link
```
