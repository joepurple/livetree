# treeswitch

`treeswitch` switches a stable runner symlink for a Git project:

```text
<main-worktree>/.live-tree/src -> <selected-worktree>
```

Run it from any worktree that belongs to the project.

```sh
treeswitch
treeswitch <selector>
treeswitch rm
```

`tsw` is installed as a shorthand for the same command.

With no selector, `treeswitch` opens a small picker. With a selector, it matches a worktree path, basename, branch name, commit hash prefix, Codex thread id prefix, or Codex chat title fragment.

Use `treeswitch rm`, `treeswitch remove`, or `treeswitch delete` to select linked worktrees to remove. The main worktree is not removable through this command, and selected worktrees are shown again with their paths before removal. Type `delete` at the confirmation prompt to continue.

Install locally while developing:

```sh
npm install
npm link
```
