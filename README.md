# livetree

`lt` switches a stable runner symlink for a Git project:

```text
<main-worktree>/.livetree/src -> <selected-worktree>
```

Run it from any worktree that belongs to the project.

```sh
lt
lt use [selector]
lt @<selector>
lt <script-name> [args...]
lt ls
lt cd [selector]
lt init
lt run <script-name> [args...]
lt watch <script-name> [args...]
lt : <shell-command> [args...]
lt run: <shell-command> [args...]
lt watch: <shell-command> [args...]
lt rm
lt install tools
```

With no arguments, `lt` opens the fullscreen searchable switcher. Type to fuzzy-filter by label, path, branch, commit hash, Codex thread id, or Codex chat title; use Up/Down to move, Enter to switch to the highlighted worktree, Esc to clear the search box, and Ctrl-C to exit. The fullscreen switcher updates live when worktrees, Codex metadata, or the active live tree change. To switch directly, use `lt use <selector>` or `lt @<selector>`. Selectors match `root` for the main project worktree, a worktree path, basename, branch name, commit hash prefix, Codex thread id prefix, or Codex chat title fragment.

Put another `lt` command after `@<selector>` to run that command inside the selected worktree without changing `.livetree/src`:

```sh
lt @dark-mode-mobile : pwd
lt @dark-mode-mobile api
```

Use `lt ls` to print worktrees without selecting or switching the active worktree:

```text
10m  * Plan push notifications rollout [push-notifs]
    /Users/avinoam/.codex/worktrees/b3d2/ecosconnect
1h     ROOT [mobile-dev]
    /Users/avinoam/code/ecosconnect
```

Use `lt cd` to select a worktree and copy a ready-to-paste `cd <worktree>` command to the macOS pasteboard. Use `lt cd <selector>` to copy a command directly.

Install zsh tab completion into `~/.zshrc`:

```sh
lt install tools
```

Selector completions are available for `lt use`, `lt cd`, and `lt @<selector>`.

Use `lt init` to initialize every worktree that has not been initialized yet. A worktree is considered initialized when `<worktree>/.livetree` exists. For each uninitialized worktree, `lt` copies any configured files from the main worktree, runs the project init script in that worktree, then writes `<worktree>/.livetree/.source` as the initialization marker. Define init behavior in `.ltconf` at the main worktree root:

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

Define reusable `lt` commands under `run`:

```yaml
run:
  api: cd src/modules/api && pnpm start
  web: cd src/modules/web && pnpm start
  mobile: cd src/modules/mobile && pnpm start
```

Run them once with `lt api` or `lt run api`. Built-in commands take precedence over run script shortcuts. Run scripts start in the active live worktree directory.

Use `lt :` to run an ad hoc shell command from the active live worktree directory:

```sh
lt : git status
lt run: git status
lt : "pwd && git status --short"
```

Quote the whole command when using shell operators like `&&`, pipes, or redirects.

Use `lt watch:` to run an ad hoc shell command from the active live worktree directory again whenever `.livetree/src` points at a new source. If the command is still running when the live worktree changes, `lt` stops it before starting it in the new source:

```sh
lt watch: npm test
lt watch: "pwd && git status --short"
```

Use `lt watch api` to keep a script tied to the live worktree. `lt` watches `.livetree/src`; when you switch the active worktree, it stops the current process tree and starts the script again against the new target:

```sh
lt watch web
```

Any extra arguments after the script name are passed through to the configured command:

```sh
lt lt init
```

Use `lt rm` to select linked worktrees to remove. Tab or Space toggles the highlighted worktree. The main worktree is not removable through this command, and selected worktrees are shown again with their paths before removal. Confirm with `y`; anything else cancels. If Git refuses because a selected worktree has modified or untracked files, `lt` asks before retrying that worktree with `--force`. If Git reports a stale/prunable worktree whose `.git` file is already missing, `lt` prunes the stale Git metadata and asks before deleting the leftover directory. When a removed worktree has an associated Codex chat, `lt` archives it with `codex archive`.

Install locally while developing:

```sh
npm install
npm link
```
