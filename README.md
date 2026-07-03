# livetree

`livetree` switches a stable runner symlink for a Git project:

```text
<main-worktree>/.livetree/src -> <selected-worktree>
```

Run it from any worktree that belongs to the project.

```sh
livetree
livetree <selector>
livetree list
livetree ls
livetree init
livetree run <script-name> [args...]
livetree watch <script-name> [args...]
livetree rm
```

`lt` is installed as a shorthand for the same command.

With no selector, `livetree` opens a small picker. With a selector, it matches a worktree path, basename, branch name, commit hash prefix, Codex thread id prefix, or Codex chat title fragment.

Use `livetree list` or `lt ls` to print worktrees newest-modified first:

```text
10m  * Plan push notifications rollout [push-notifs]
    /Users/avinoam/.codex/worktrees/b3d2/ecosconnect
1h     ROOT [mobile-dev]
    /Users/avinoam/code/ecosconnect
```

Use `livetree init` to initialize every worktree that has not been initialized yet. A worktree is considered initialized when `<worktree>/.livetree` exists. For each uninitialized worktree, `livetree` copies any configured files from the main worktree, runs the project init script in that worktree, then writes `<worktree>/.livetree/.source` as the initialization marker. Define init behavior in `.ltconf` at the main worktree root:

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

Define reusable livetree commands under `run`:

```yaml
run:
  api: cd src/modules/api && pnpm start
  web: cd src/modules/web && pnpm start
  mobile: cd src/modules/mobile && pnpm start
```

Run them once with `livetree run api` or `lt run api`. Run scripts start in `<main-worktree>/.livetree`, so paths should go through `src/...`.

Use `livetree watch api` or `lt watch api` to keep a script tied to the live worktree. `livetree` watches `.livetree/src`; when you switch the active worktree, it stops the current process tree and starts the script again against the new target:

```sh
lt watch web
```

Any extra arguments after the script name are passed through to the configured command:

```sh
lt run lt init
```

Use `livetree rm`, `livetree remove`, or `livetree delete` to select linked worktrees to remove. The main worktree is not removable through this command, and selected worktrees are shown again with their paths before removal. Confirm with `y`; anything else cancels. If Git refuses because a selected worktree has modified or untracked files, `livetree` asks before retrying that worktree with `--force`. If Git reports a stale/prunable worktree whose `.git` file is already missing, `livetree` prunes the stale Git metadata and asks before deleting the leftover directory.

Install locally while developing:

```sh
npm install
npm link
```
